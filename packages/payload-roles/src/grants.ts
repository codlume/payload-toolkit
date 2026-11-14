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
  const cells: Grant[] = [];
  for (const grants of all) {
    cells.push(...grants);
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

const parseActions = (
  actions: unknown,
  resourceId: ResourceId,
  path: string,
  registry: Registry,
  cells: Grant[],
  issues: CellIssue[],
) => {
  if (!Array.isArray(actions)) {
    issues.push({ path, resource: resourceId, action: null, reason: "malformed" });
    return;
  }
  const resource = registry.get(resourceId);
  for (const action of actions) {
    if (typeof action !== "string" || !isActionId(action)) {
      issues.push({ path, resource: resourceId, action: null, reason: "unknown-action" });
    } else if (!resource) {
      issues.push({ path, resource: resourceId, action, reason: "unknown-resource" });
    } else if (!resource.actions.has(action)) {
      issues.push({ path, resource: resourceId, action, reason: "inapplicable" });
    } else {
      cells.push(grantId(resourceId, action));
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
    for (const [slug, entry] of Object.entries(entries)) {
      const resourceId: ResourceId = `${kind}:${slug}`;
      const path = `permissions.${kind}.${slug}`;
      if (!isRecord(entry) || Object.keys(entry).some((key) => key !== "actions")) {
        issues.push({ path, resource: resourceId, action: null, reason: "malformed" });
        continue;
      }
      parseActions(entry.actions, resourceId, `${path}.actions`, registry, cells, issues);
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
