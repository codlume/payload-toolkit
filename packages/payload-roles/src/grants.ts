import {
  ACTION_IDS,
  type ActionId,
  type Capabilities,
  type CellIssue,
  type Grant,
  type Grants,
  type Registry,
  type ResourceId,
  type StoredPermissions,
} from "./contract.ts";

const ACTION_SET: ReadonlySet<string> = new Set(ACTION_IDS);

const isActionId = (value: string): value is ActionId => ACTION_SET.has(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The only place a `Grants` value is constructed. Callers pass cells they already validated. */
export const grantsOf = (cells: Iterable<Grant>): Grants =>
  Object.assign(new Set(cells), { __brand: "Grants" as const });

export const EMPTY_GRANTS = grantsOf([]);

export const NO_CAPABILITIES: Capabilities = { kind: "grants", grants: EMPTY_GRANTS };

export const grantId = (resource: ResourceId, action: ActionId): Grant => `${resource}#${action}`;

export const unionGrants = (all: Iterable<Grants>): Grants => {
  const cells = new Set<Grant>();
  for (const grants of all) {
    for (const cell of grants) {
      cells.add(cell);
    }
  }
  return grantsOf(cells);
};

export const can = (capabilities: Capabilities, resource: ResourceId, action: ActionId) =>
  capabilities.kind === "all" || capabilities.grants.has(grantId(resource, action));

/** Cells of `inner` that `outer` does not hold. Empty means `outer` covers `inner`. */
export const missingFrom = (inner: Grants, outer: Capabilities): Grant[] =>
  outer.kind === "all" ? [] : [...inner].filter((cell) => !outer.grants.has(cell));

export const covers = (outer: Capabilities, inner: Capabilities) =>
  outer.kind === "all" ||
  (inner.kind === "grants" && missingFrom(inner.grants, outer).length === 0);

type Parsed = { grants: Grants; issues: CellIssue[] };

const KINDS = { collections: "collections", globals: "globals" } as const;

type KindKey = keyof typeof KINDS;

type CellTable = Record<KindKey, Map<string, ReadonlyMap<string, Grant>>>;

const cellTables = new WeakMap<Registry, CellTable>();

/**
 * Every cell a registry can grant, by kind, slug and action. Built once per registry, so parsing
 * a role looks each grant id up instead of building its string.
 */
const cellTableOf = (registry: Registry): CellTable => {
  const built = cellTables.get(registry);
  if (built) {
    return built;
  }
  const table: CellTable = { collections: new Map(), globals: new Map() };
  for (const [id, resource] of registry) {
    table[kindKeyOf(id)].set(
      slugOf(id),
      new Map([...resource.actions].map((action) => [action, grantId(id, action)])),
    );
  }
  cellTables.set(registry, table);
  return table;
};

const parseActions = (
  actions: unknown,
  kind: KindKey,
  slug: string,
  known: ReadonlyMap<string, Grant> | undefined,
  cells: Grant[],
  issues: CellIssue[],
) => {
  const issue = (action: ActionId | null, reason: CellIssue["reason"]) =>
    issues.push({
      path: `permissions.${kind}.${slug}.actions`,
      resource: `${kind}:${slug}`,
      action,
      reason,
    });
  if (!Array.isArray(actions)) {
    issue(null, "malformed");
    return;
  }
  for (const action of actions) {
    const cell = typeof action === "string" ? known?.get(action) : undefined;
    if (cell !== undefined) {
      cells.push(cell);
    } else if (typeof action !== "string" || !isActionId(action)) {
      issue(null, "unknown-action");
    } else {
      issue(action, known ? "inapplicable" : "unknown-resource");
    }
  }
};

/**
 * Read boundary for the `permissions` JSON. Never throws. Invalid cells are reported and
 * dropped, so a malformed role grants nothing it does not spell out correctly.
 */
export const parsePermissions = (raw: unknown, registry: Registry): Parsed => {
  const cells: Grant[] = [];
  const issues: CellIssue[] = [];
  if (raw === undefined || raw === null) {
    return { grants: EMPTY_GRANTS, issues };
  }
  if (!isRecord(raw)) {
    issues.push({ path: "permissions", resource: null, action: null, reason: "malformed" });
    return { grants: EMPTY_GRANTS, issues };
  }
  for (const kind of Object.keys(raw)) {
    if (!Object.hasOwn(KINDS, kind)) {
      issues.push({
        path: `permissions.${kind}`,
        resource: null,
        action: null,
        reason: "malformed",
      });
    }
  }
  const table = cellTableOf(registry);
  for (const kind of Object.values(KINDS)) {
    const entries = raw[kind];
    if (entries === undefined) {
      continue;
    }
    if (!isRecord(entries)) {
      issues.push({
        path: `permissions.${kind}`,
        resource: null,
        action: null,
        reason: "malformed",
      });
      continue;
    }
    const resources = table[kind];
    for (const [slug, entry] of Object.entries(entries)) {
      if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "actions")) {
        issues.push({
          path: `permissions.${kind}.${slug}`,
          resource: `${kind}:${slug}`,
          action: null,
          reason: "malformed",
        });
        continue;
      }
      parseActions(entry.actions, kind, slug, resources.get(slug), cells, issues);
    }
  }
  return { grants: grantsOf(cells), issues };
};

const kindKeyOf = (resourceId: ResourceId): KindKey =>
  resourceId.startsWith("collections:") ? "collections" : "globals";

const slugOf = (resourceId: ResourceId) => resourceId.slice(resourceId.indexOf(":") + 1);

const actionsPath = (resourceId: ResourceId) =>
  `permissions.${kindKeyOf(resourceId)}.${slugOf(resourceId)}.actions`;

const splitCell = (cell: Grant): { resource: ResourceId; action: ActionId } => {
  const at = cell.lastIndexOf("#");
  const resource = cell.slice(0, at);
  const action = cell.slice(at + 1);
  if (!isActionId(action) || !isResourceId(resource)) {
    throw new TypeError(`Not a grant cell: ${cell}`);
  }
  return { resource, action };
};

const isResourceId = (value: string): value is ResourceId =>
  value.startsWith("collections:") || value.startsWith("globals:");

/**
 * Write boundary. Shape issues from the parser, plus the v1 rule that `publish` needs
 * `update` on the same resource, plus every cell the editor does not hold.
 */
export const checkPermissions = (
  raw: unknown,
  registry: Registry,
  editor: Capabilities,
): Parsed => {
  const parsed = parsePermissions(raw, registry);
  const issues = [...parsed.issues];
  for (const cell of parsed.grants) {
    const { resource, action } = splitCell(cell);
    if (action === "publish" && !parsed.grants.has(grantId(resource, "update"))) {
      issues.push({ path: actionsPath(resource), resource, action, reason: "requires-update" });
    }
    if (!can(editor, resource, action)) {
      issues.push({ path: actionsPath(resource), resource, action, reason: "not-held" });
    }
  }
  return { grants: parsed.grants, issues };
};

/** Canonical stored form: registry order, ACTION_IDS order, applicable cells only. */
export const serializePermissions = (grants: Grants, registry: Registry): StoredPermissions => {
  const stored: Required<StoredPermissions> = { collections: {}, globals: {} };
  for (const resource of registry.values()) {
    const actions = ACTION_IDS.filter(
      (action) => resource.actions.has(action) && grants.has(grantId(resource.id, action)),
    );
    if (actions.length > 0) {
      stored[kindKeyOf(resource.id)][resource.slug] = { actions };
    }
  }
  return stored;
};

export const describeCellIssue = (issue: CellIssue): string => {
  const action = issue.action === null ? "" : ` "${issue.action}"`;
  switch (issue.reason) {
    case "malformed":
      return "Permissions must be { collections?: { [slug]: { actions: string[] } }, globals?: { [slug]: { actions: string[] } } }.";
    case "unknown-resource":
      return `"${issue.resource ?? ""}" is not managed by the roles plugin.`;
    case "unknown-action":
      return `Unknown action; expected one of ${ACTION_IDS.join(", ")}.`;
    case "inapplicable":
      return `Action${action} does not apply to "${issue.resource ?? ""}".`;
    case "requires-update":
      return `Action "publish" requires "update" on the same resource.`;
    case "not-held": {
      return `You cannot grant action${action} on "${issue.resource ?? ""}" because you do not hold it.`;
    }
    default: {
      const exhaustive: never = issue.reason;
      return exhaustive;
    }
  }
};
