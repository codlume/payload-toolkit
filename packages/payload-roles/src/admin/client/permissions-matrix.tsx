import { FieldDescription, FieldLabel, useField } from "@payloadcms/ui";
import type { JSONFieldClientProps } from "payload";
import React, {
  type ChangeEvent,
  memo,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { Grant, MatrixColumn, MatrixModel, MatrixRow, StorageKind } from "../model.ts";
import {
  applyOp,
  type Cells,
  grantableCells,
  type MatrixOp,
  pickerWarning,
  placeFieldErrors,
  readMatrix,
} from "./matrix.ts";

export type PermissionsMatrixProps = {
  field: JSONFieldClientProps["field"];
  path: string;
  model: MatrixModel;
};

const EMPTY: Cells = new Set();

const GROUPS: readonly { kind: StorageKind; label: string }[] = [
  { kind: "collections", label: "Collections" },
  { kind: "globals", label: "Globals" },
];

const CSS = `
.roles-matrix { margin-bottom: var(--base); }
.roles-matrix__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.roles-matrix__toolbar { display: flex; flex-wrap: wrap; gap: calc(var(--base) * 0.5) var(--base); align-items: end; margin-bottom: calc(var(--base) * 0.5); }
.roles-matrix__control { display: flex; flex-direction: column; gap: calc(var(--base) * 0.2); }
.roles-matrix__control-row { display: flex; gap: calc(var(--base) * 0.25); }
.roles-matrix input[type="search"], .roles-matrix select { min-height: calc(var(--base) * 1.6); padding: 0 calc(var(--base) * 0.4); border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); background: var(--theme-input-bg); color: var(--theme-text); font: inherit; }
.roles-matrix button { min-height: calc(var(--base) * 1.2); padding: 0 calc(var(--base) * 0.4); border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); background: var(--theme-elevation-0); color: var(--theme-text); font: inherit; font-size: 0.85em; cursor: pointer; }
.roles-matrix button:hover:not(:disabled) { background: var(--theme-elevation-100); }
.roles-matrix button:disabled { cursor: default; opacity: 0.5; }
.roles-matrix__notice { margin: 0 0 calc(var(--base) * 0.5); padding: calc(var(--base) * 0.4) calc(var(--base) * 0.6); border-left: 3px solid var(--theme-elevation-400); border-radius: var(--style-radius-s); background: var(--theme-elevation-50); }
.roles-matrix__notice p, .roles-matrix__notice ul { margin: 0; }
.roles-matrix__notice ul { padding-left: var(--base); }
.roles-matrix__notice button { margin-top: calc(var(--base) * 0.3); }
.roles-matrix__notice--error { border-left-color: var(--theme-error-500); }
.roles-matrix__error { display: block; color: var(--theme-error-500); font-weight: normal; font-size: 0.85em; }
.roles-matrix__scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--theme-border-color); border-radius: var(--style-radius-s); }
.roles-matrix table { width: 100%; border-collapse: separate; border-spacing: 0; }
.roles-matrix th, .roles-matrix td { padding: calc(var(--base) * 0.3) calc(var(--base) * 0.5); border-bottom: 1px solid var(--theme-border-color); background: var(--theme-elevation-0); text-align: center; white-space: nowrap; }
.roles-matrix thead th { position: sticky; top: 0; z-index: 2; background: var(--theme-elevation-50); font-weight: 600; vertical-align: bottom; }
.roles-matrix thead th button { display: block; margin: calc(var(--base) * 0.2) auto 0; }
.roles-matrix thead th:first-child, .roles-matrix tbody th[scope="row"] { position: sticky; left: 0; z-index: 1; text-align: left; }
.roles-matrix thead th:first-child { z-index: 3; }
.roles-matrix tbody th[scope="rowgroup"] { background: var(--theme-elevation-100); text-align: left; font-weight: 600; }
.roles-matrix tbody th[scope="row"] { font-weight: normal; }
.roles-matrix input[type="checkbox"] { width: calc(var(--base) * 0.8); height: calc(var(--base) * 0.8); margin: 0; accent-color: var(--theme-elevation-800); cursor: pointer; }
.roles-matrix input[type="checkbox"]:disabled { cursor: default; }
`;

/** Keys a message list so a repeated message still gets a unique React key. */
const keyed = (messages: readonly string[]) => {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const count = (seen.get(message) ?? 0) + 1;
    seen.set(message, count);
    return { key: `${count}:${message}`, message };
  });
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

const Notice = ({ children, error = false }: { children: React.ReactNode; error?: boolean }) => (
  <div className={`roles-matrix__notice${error ? " roles-matrix__notice--error" : ""}`}>
    {children}
  </div>
);

const allChecked = (cells: Cells, targets: readonly Grant[]) =>
  targets.length > 0 && targets.every((cell) => cells.has(cell));

const ToggleButton = ({
  clears,
  disabled,
  onToggle,
  subject,
  targets,
}: {
  clears: boolean;
  disabled: boolean;
  onToggle: (targets: readonly Grant[]) => void;
  subject: string;
  targets: readonly Grant[];
}) => {
  const text = clears ? "Clear" : "All";
  return (
    <button
      aria-label={`${text} ${subject}`}
      disabled={disabled || targets.length === 0}
      onClick={() => onToggle(targets)}
      type="button"
    >
      {text}
    </button>
  );
};

/** One resource row. `checked` holds bit `j` for `columns[j]`, so a click re-renders only its row. */
const Row = memo(
  ({
    canEdit,
    checked,
    clears,
    columns,
    errors,
    onCell,
    onToggle,
    ready,
    row,
    targets,
  }: {
    canEdit: boolean;
    checked: number;
    clears: boolean;
    columns: readonly MatrixColumn[];
    errors: readonly string[] | undefined;
    onCell: (event: ChangeEvent<HTMLInputElement>) => void;
    onToggle: (targets: readonly Grant[]) => void;
    ready: boolean;
    row: MatrixRow;
    targets: readonly Grant[];
  }) => (
    <tr>
      <th scope="row">
        {row.label}
        {keyed(errors ?? []).map(({ key, message }) => (
          <span className="roles-matrix__error" key={key} role="alert">
            {message}
          </span>
        ))}
      </th>
      {columns.map((column, bit) => {
        const mode = row.cells[column.action];
        return (
          <td key={column.action}>
            {mode === undefined ? (
              <span className="roles-matrix__sr">Not applicable</span>
            ) : (
              <input
                aria-label={`${row.label}: ${column.label}`}
                checked={(checked & (1 << bit)) !== 0}
                disabled={!ready || mode === "fixed"}
                onChange={onCell}
                type="checkbox"
                value={`${row.id}#${column.action}`}
              />
            )}
          </td>
        );
      })}
      <td>
        <ToggleButton
          clears={clears}
          disabled={!canEdit}
          onToggle={onToggle}
          subject={`${row.label} permissions`}
          targets={targets}
        />
      </td>
    </tr>
  ),
);

export const PermissionsMatrix = ({ field, path, model }: PermissionsMatrixProps) => {
  const { value, setValue, errorMessage, showError } = useField<unknown>({
    potentiallyStalePath: path,
  });
  const view = useMemo(() => readMatrix(model, value), [model, value]);
  const shownError = showError && typeof errorMessage === "string" ? errorMessage : "";
  const placed = useMemo(() => placeFieldErrors(model, shownError), [model, shownError]);
  const [filter, setFilter] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [report, setReport] = useState<{
    value: unknown;
    name: string;
    skipped: readonly Grant[];
  } | null>(null);
  const id = useId();

  const layout = useMemo(() => {
    const actions = model.columns.map((column) => column.action);
    const cellOf = new Map<string, Grant>();
    const labelOf = new Map<Grant, string>();
    const rows = model.rows.map((row) => {
      const grid = model.columns.map((column): Grant | null => {
        if (row.cells[column.action] === undefined) {
          return null;
        }
        const cell: Grant = `${row.id}#${column.action}`;
        cellOf.set(cell, cell);
        labelOf.set(cell, `${row.label}: ${column.label}`);
        return cell;
      });
      return {
        row,
        grid,
        targets: grantableCells(row, actions),
        label: row.label.toLowerCase(),
        slug: row.slug.toLowerCase(),
      };
    });
    const grantable = model.rows.some((row) => Object.values(row.cells).includes("grantable"));
    return { cellOf, labelOf, rows, grantable };
  }, [model]);
  const { cellOf, labelOf } = layout;

  const ready = view.status === "ready";
  const cells = ready ? view.cells : EMPTY;
  const canEdit = ready && layout.grantable;
  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () =>
      layout.rows.filter(
        (entry) => needle === "" || entry.label.includes(needle) || entry.slug.includes(needle),
      ),
    [layout, needle],
  );
  const headers = useMemo(
    () =>
      model.columns.map((column) => ({
        column,
        targets: visible.flatMap((entry) => grantableCells(entry.row, [column.action])),
      })),
    [model, visible],
  );
  const describe = (list: readonly Grant[]) =>
    list.map((cell) => labelOf.get(cell) ?? cell).join(", ");

  const latest = useRef({ model, view, setValue });
  useLayoutEffect(() => {
    latest.current = { model, view, setValue };
  });

  const run = useCallback((op: MatrixOp) => {
    const current = latest.current;
    if (current.view.status !== "ready") {
      return null;
    }
    const outcome = applyOp(current.model, current.view.cells, op);
    current.setValue(outcome.value);
    return outcome;
  }, []);

  const onToggle = useCallback(
    (targets: readonly Grant[]) => {
      run({ type: "toggle", cells: targets });
    },
    [run],
  );

  const onCell = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const cell = cellOf.get(event.currentTarget.value);
      if (cell) {
        run({ type: "cell", cell, on: event.currentTarget.checked });
      }
    },
    [cellOf, run],
  );

  const source = model.copySources.find((candidate) => candidate.id === sourceId);
  const onCopy = () => {
    if (!source) {
      return;
    }
    const outcome = run({ type: "copy", source });
    if (outcome) {
      setReport({ value: outcome.value, name: source.name, skipped: outcome.skipped });
    }
  };

  const description = field.admin?.description;
  const fieldErrors = placed.field;
  const columnCount = model.columns.length + 2;

  return (
    <div className={`field-type json roles-matrix${fieldErrors.length > 0 ? " error" : ""}`}>
      <style>{CSS}</style>
      <FieldLabel
        label={
          typeof field.label === "string" || typeof field.label === "object"
            ? field.label
            : "Permissions"
        }
        path={path}
        required={field.required === true}
      />
      {typeof description === "string" || typeof description === "object" ? (
        <FieldDescription description={description} path={path} />
      ) : null}
      {model.enforced ? null : (
        <Notice>
          <p>
            Role limits are not enforced. The roles plugin is disabled, so these permissions have no
            effect until it is enabled.
          </p>
        </Notice>
      )}
      {model.lock?.kind === "read-only" ? (
        <Notice>
          <p>You can view this role but cannot change it.</p>
        </Notice>
      ) : null}
      {model.lock?.kind === "not-covered" ? (
        <Notice>
          <p>
            You cannot change this role because it grants permissions you do not hold:{" "}
            {describe(model.lock.missing)}.
          </p>
        </Notice>
      ) : null}
      {ready ? null : (
        <Notice error>
          <p>These permissions cannot be shown as a matrix. Reload the page before editing them.</p>
        </Notice>
      )}
      {view.status === "ready" && view.untouched && model.stored.issues.length > 0 ? (
        <Notice error>
          <p>The stored permissions have entries the plugin rejects on save:</p>
          <ul>
            {keyed(model.stored.issues.map((issue) => issue.message)).map(({ key, message }) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
          {canEdit ? (
            <button onClick={() => run({ type: "clean" })} type="button">
              Remove invalid entries
            </button>
          ) : null}
        </Notice>
      ) : null}
      {pickerWarning(model, cells) ? (
        <Notice>
          <p>
            Holders can edit users, but the Roles picker on a user stays empty without Read on
            Roles. A role grants nothing implicitly.
          </p>
        </Notice>
      ) : null}
      {report !== null && report.value === value ? (
        <Notice>
          <p role="status">
            Copied from {report.name}.
            {report.skipped.length > 0
              ? ` ${plural(report.skipped.length, "cell")} kept their value because you cannot change them: ${describe(report.skipped)}.`
              : ""}
          </p>
        </Notice>
      ) : null}
      {fieldErrors.length > 0 ? (
        <Notice error>
          <ul role="alert">
            {keyed(fieldErrors).map(({ key, message }) => (
              <li key={key}>{message}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
      <div className="roles-matrix__toolbar">
        <div className="roles-matrix__control">
          <label htmlFor={`${id}-filter`}>Filter resources</label>
          <input
            id={`${id}-filter`}
            onChange={(event) => setFilter(event.currentTarget.value)}
            type="search"
            value={filter}
          />
        </div>
        {model.copySources.length > 0 ? (
          <div className="roles-matrix__control">
            <label htmlFor={`${id}-copy`}>Copy from role</label>
            <div className="roles-matrix__control-row">
              <select
                disabled={!canEdit}
                id={`${id}-copy`}
                onChange={(event) => setSourceId(event.currentTarget.value)}
                value={sourceId}
              >
                <option value="">Choose a role</option>
                {model.copySources.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
              <button disabled={!canEdit || !source} onClick={onCopy} type="button">
                Copy
              </button>
            </div>
          </div>
        ) : null}
        {model.assignment ? (
          <a href={model.assignment.href}>Assigned to {plural(model.assignment.count, "user")}</a>
        ) : null}
      </div>
      <div className="roles-matrix__scroll">
        <table>
          <caption className="roles-matrix__sr">Permissions by resource and action</caption>
          <thead>
            <tr>
              <th scope="col">Resource</th>
              {headers.map(({ column, targets }) => (
                <th key={column.action} scope="col">
                  {column.label}
                  <ToggleButton
                    clears={allChecked(cells, targets)}
                    disabled={!canEdit}
                    onToggle={onToggle}
                    subject={`${column.label} on shown resources`}
                    targets={targets}
                  />
                </th>
              ))}
              <th scope="col">
                <span className="roles-matrix__sr">Whole row</span>
              </th>
            </tr>
          </thead>
          {GROUPS.map((group) => {
            const entries = visible.filter((entry) => entry.row.kind === group.kind);
            return entries.length === 0 ? null : (
              <tbody key={group.kind}>
                <tr>
                  <th colSpan={columnCount} scope="rowgroup">
                    {group.label}
                  </th>
                </tr>
                {entries.map(({ grid, row, targets }) => (
                  <Row
                    canEdit={canEdit}
                    checked={grid.reduce(
                      (bits, cell, bit) =>
                        cell !== null && cells.has(cell) ? bits | (1 << bit) : bits,
                      0,
                    )}
                    clears={allChecked(cells, targets)}
                    columns={model.columns}
                    errors={placed.byRow.get(row.id)}
                    key={row.id}
                    onCell={onCell}
                    onToggle={onToggle}
                    ready={ready}
                    row={row}
                    targets={targets}
                  />
                ))}
              </tbody>
            );
          })}
        </table>
        {visible.length === 0 ? (
          <p className="roles-matrix__notice">No resources match the filter.</p>
        ) : null}
      </div>
    </div>
  );
};
