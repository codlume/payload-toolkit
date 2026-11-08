// Imports core types only: a runtime import shared with the server entry would split into a fifth
// dist file.
import type { ActionId, Grant, ResourceId, StoredPermissions } from "../../contract.ts";
import type { CellMode, CopySource, MatrixModel, MatrixRow } from "../model.ts";

export type Cells = ReadonlySet<Grant>;

export type MatrixView =
  | { status: "unreadable" }
  | { status: "ready"; cells: Cells; untouched: boolean };

export type MatrixOp =
  | { type: "cell"; cell: Grant; on: boolean }
  | { type: "row"; row: ResourceId }
  | { type: "column"; action: ActionId; rows: readonly ResourceId[] }
  | { type: "copy"; source: CopySource }
  | { type: "clean" };

export type Outcome = {
  value: StoredPermissions;
  cells: Cells;
  skipped: readonly Grant[];
};

export type ServerIssue = { path: string; message: string };

type FieldsSnapshot = Readonly<
  Record<string, { errorMessage?: string | undefined; value?: unknown } | undefined>
>;

type Index = {
  modes: ReadonlyMap<Grant, CellMode>;
  rows: ReadonlyMap<string, MatrixRow>;
  byId: ReadonlyMap<ResourceId, MatrixRow>;
};

const indexes = new WeakMap<MatrixModel, Index>();

const grantOf = (row: ResourceId, action: ActionId): Grant => `${row}#${action}`;

const indexOf = (model: MatrixModel): Index => {
  const cached = indexes.get(model);
  if (cached) {
    return cached;
  }
  const modes = new Map<Grant, CellMode>();
  for (const row of model.rows) {
    for (const { action } of model.columns) {
      const mode = row.cells[action];
      if (mode) {
        modes.set(grantOf(row.id, action), mode);
      }
    }
  }
  const index: Index = {
    modes,
    rows: new Map(model.rows.map((row) => [`${row.kind}.${row.slug}`, row])),
    byId: new Map(model.rows.map((row) => [row.id, row])),
  };
  indexes.set(model, index);
  return index;
};

const applicable = (model: MatrixModel, row: MatrixRow) =>
  model.columns.filter(({ action }) => row.cells[action] !== undefined).map(({ action }) => action);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasPublishWithoutUpdate = (model: MatrixModel, cells: Cells) =>
  model.rows.some(
    (row) => cells.has(grantOf(row.id, "publish")) && !cells.has(grantOf(row.id, "update")),
  );

const decode = (model: MatrixModel, value: unknown): Cells | null => {
  if (value === null || value === undefined) {
    return new Set();
  }
  if (!isRecord(value)) {
    return null;
  }
  const { rows } = indexOf(model);
  const cells = new Set<Grant>();
  for (const [kind, entries] of Object.entries(value)) {
    if ((kind !== "collections" && kind !== "globals") || !isRecord(entries)) {
      return null;
    }
    for (const [slug, entry] of Object.entries(entries)) {
      const row = rows.get(`${kind}.${slug}`);
      if (
        !row ||
        !isRecord(entry) ||
        Object.keys(entry).some((key) => key !== "actions") ||
        !Array.isArray(entry.actions)
      ) {
        return null;
      }
      for (const raw of entry.actions) {
        const column = model.columns.find(
          ({ action }) => action === raw && row.cells[action] !== undefined,
        );
        if (!column) {
          return null;
        }
        cells.add(grantOf(row.id, column.action));
      }
    }
  }
  return hasPublishWithoutUpdate(model, cells) ? null : cells;
};

const encode = (model: MatrixModel, cells: Cells): StoredPermissions => {
  const stored: Required<StoredPermissions> = { collections: {}, globals: {} };
  for (const row of model.rows) {
    const actions = applicable(model, row).filter((action) => cells.has(grantOf(row.id, action)));
    if (actions.length > 0) {
      stored[row.kind][row.slug] = { actions };
    }
  }
  return stored;
};

const fingerprintOf = (value: unknown) => JSON.stringify(value ?? null);

export const readMatrix = (model: MatrixModel, value: unknown): MatrixView => {
  const untouched = fingerprintOf(value) === model.stored.fingerprint;
  const decoded = decode(model, value);
  if (decoded) {
    return { status: "ready", cells: decoded, untouched };
  }
  return untouched
    ? { status: "ready", cells: new Set(model.stored.granted), untouched }
    : { status: "unreadable" };
};

export const grantableCells = (row: MatrixRow, actions: readonly ActionId[]): Grant[] =>
  actions.filter((action) => row.cells[action] === "grantable").map((a) => grantOf(row.id, a));

const toggle = (cells: Cells, targets: readonly Grant[]) => {
  const on = !targets.every((cell) => cells.has(cell));
  return new Map(targets.map((cell) => [cell, on]));
};

const intentOf = (model: MatrixModel, cells: Cells, op: MatrixOp): Map<Grant, boolean> => {
  const { byId } = indexOf(model);
  switch (op.type) {
    case "cell": {
      return new Map([[op.cell, op.on]]);
    }
    case "row": {
      const row = byId.get(op.row);
      return row ? toggle(cells, grantableCells(row, applicable(model, row))) : new Map();
    }
    case "column": {
      const targets = op.rows.flatMap((id) => {
        const row = byId.get(id);
        return row ? grantableCells(row, [op.action]) : [];
      });
      return toggle(cells, targets);
    }
    case "copy": {
      const source = new Set(op.source.granted);
      return new Map(
        model.rows.flatMap((row) =>
          applicable(model, row).map((action): [Grant, boolean] => {
            const cell = grantOf(row.id, action);
            return [cell, source.has(cell)];
          }),
        ),
      );
    }
    case "clean": {
      return new Map();
    }
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
};

const couple = (model: MatrixModel, intent: ReadonlyMap<Grant, boolean>) => {
  const desired = new Map(intent);
  for (const row of model.rows) {
    if (row.cells.publish === undefined) {
      continue;
    }
    const publish = grantOf(row.id, "publish");
    const update = grantOf(row.id, "update");
    if (desired.get(update) === false) {
      desired.set(publish, false);
    } else if (desired.get(publish) === true) {
      desired.set(update, true);
    }
  }
  return desired;
};

export const applyOp = (model: MatrixModel, cells: Cells, op: MatrixOp): Outcome => {
  const { modes } = indexOf(model);
  const intent = intentOf(model, cells, op);
  const next = new Set(cells);
  for (const [cell, on] of couple(model, intent)) {
    if (modes.get(cell) !== "grantable") {
      continue;
    }
    if (on) {
      next.add(cell);
    } else {
      next.delete(cell);
    }
  }
  for (const row of model.rows) {
    const publish = grantOf(row.id, "publish");
    const update = grantOf(row.id, "update");
    if (!next.has(publish) || next.has(update)) {
      continue;
    }
    if (modes.get(publish) === "grantable") {
      next.delete(publish);
    } else if (cells.has(update) && modes.get(update) === "grantable") {
      next.add(update);
    }
  }
  const skipped = [...intent].filter(([cell, on]) => next.has(cell) !== on).map(([cell]) => cell);
  return { value: encode(model, next), cells: next, skipped };
};

export const pickerWarning = (model: MatrixModel, cells: Cells) => {
  const check = model.pickerCheck;
  return check !== null && check.assigns.some((cell) => cells.has(cell)) && !cells.has(check.needs);
};

const isServerKey = (key: string, path: string) => key.startsWith(`${path}.`);

export const serverIssueSignature = (fields: FieldsSnapshot, path: string) =>
  JSON.stringify(
    Object.keys(fields)
      .filter((key) => isServerKey(key, path))
      .map((key) => [key, fields[key]?.errorMessage ?? ""]),
  );

/**
 * The phantom entries Payload's ADD_SERVER_ERRORS created under `path`, which must be removed
 * before the form reads its data: their null values overwrite the permissions object.
 */
export const takeServerIssues = (
  fields: FieldsSnapshot,
  path: string,
): { issues: ServerIssue[]; remove: string[] } => {
  const remove = Object.keys(fields).filter((key) => isServerKey(key, path));
  const issues = remove.flatMap((key) => {
    const message = fields[key]?.errorMessage;
    return typeof message === "string" && message !== "" ? [{ path: key, message }] : [];
  });
  return { issues, remove };
};

export const placeServerIssues = (
  model: MatrixModel,
  issues: readonly ServerIssue[],
): { byRow: ReadonlyMap<ResourceId, readonly string[]>; field: readonly string[] } => {
  const byRow = new Map<ResourceId, string[]>();
  const field: string[] = [];
  for (const issue of issues) {
    const row = model.rows.find(({ path }) => path === issue.path);
    if (row) {
      byRow.set(row.id, [...(byRow.get(row.id) ?? []), issue.message]);
    } else {
      field.push(issue.message);
    }
  }
  return { byRow, field };
};
