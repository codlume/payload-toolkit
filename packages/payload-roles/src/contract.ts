// Owner: core. Frozen once the lifecycle and admin threads start building against it.
// Everything src/lifecycle/** and src/admin/** import from core lives here or is re-exported here.
import type {
  CollectionBeforeOperationHook,
  CollectionConfig,
  DefaultDocumentIDType,
  GlobalBeforeOperationHook,
  GlobalConfig,
  JSONField,
  Payload,
  PayloadRequest,
} from "payload";

export const PLUGIN_SLUG = "@codlume/payload-roles";

export const ACTION_IDS = [
  "read",
  "create",
  "update",
  "delete",
  "trash",
  "publish",
  "unpublish",
  "readVersions",
  "unlock",
] as const;

export type ActionId = (typeof ACTION_IDS)[number];

export type ResourceKind = "collection" | "global";

export type ResourceId = `collections:${string}` | `globals:${string}`;

export type Resource = {
  id: ResourceId;
  kind: ResourceKind;
  slug: string;
  drafts: boolean;
  trash: boolean;
  versions: boolean;
  auth: boolean;
  unlock: boolean;
  /** Actions that apply to this resource, in ACTION_IDS order. */
  actions: ReadonlySet<ActionId>;
};

/** Managed resources in config order: collections first, then globals. */
export type Registry = ReadonlyMap<ResourceId, Resource>;

export type Grant = `${ResourceId}#${ActionId}`;

export type Grants = ReadonlySet<Grant> & { readonly __brand: "Grants" };

export type Capabilities = { kind: "all" } | { kind: "grants"; grants: Grants };

export type SubjectId = number | string;

export type Subject =
  | { kind: "outsider" }
  | { kind: "member"; id: SubjectId; capabilities: Capabilities };

/** Shape of the roles collection's `permissions` JSON field, canonical on write. */
export type StoredPermissions = {
  collections?: Record<string, { actions: string[] }>;
  globals?: Record<string, { actions: string[] }>;
};

export type CellIssueReason =
  | "inapplicable"
  | "malformed"
  | "not-held"
  | "requires-update"
  | "unknown-action"
  | "unknown-resource";

export type CellIssue = {
  /** Field path such as `permissions.collections.pages.actions`. */
  path: string;
  resource: null | ResourceId;
  action: ActionId | null;
  reason: CellIssueReason;
};

export type ResolvedOptions = {
  collections: readonly string[];
  globals: readonly string[];
  userCollection: string;
  rolesSlug: string;
  rolesField: string;
  superAdminField: string;
  claimField: "rolesBootstrapClaim";
  permissionsField: "permissions";
  enabled: boolean;
  debug: boolean;
};

export type Diagnostics = {
  debug: (payload: Payload, event: string, fields?: Record<string, unknown>) => void;
  warn: (payload: Payload, event: string, fields?: Record<string, unknown>) => void;
  error: (payload: Payload, event: string, fields?: Record<string, unknown>) => void;
};

export type Enforcer = {
  options: ResolvedOptions;
  registry: Registry;
  /** Memoized per `req.user` object. Outsiders are anonymous requests and other auth collections. */
  subject: (req: PayloadRequest) => Promise<Subject>;
  log: Diagnostics;
};

export type WriteKey = "create" | "update";

export type WriteAccessArgs = {
  resource: Resource;
  key: WriteKey;
  /** The access function's `data`, absent for list-style probes. */
  data: Readonly<Record<string, unknown>> | undefined;
  id: DefaultDocumentIDType | undefined;
  req: PayloadRequest;
};

type CollectionHooks = NonNullable<CollectionConfig["hooks"]>;
type GlobalHooks = NonNullable<GlobalConfig["hooks"]>;

/**
 * Called synchronously from the first `beforeOperation` hook of the collection or global, which
 * core installs ahead of every app hook. It may only open the lifecycle's own
 * `AsyncLocalStorage` store with `enterWith` and copy raw `args`, because only the first hook's
 * `enterWith` reaches the operation's later hooks: Payload awaits each `beforeOperation` hook in
 * turn. The `undefined` return type keeps it synchronous; anything that awaits goes in
 * `beforeOperation`, which runs after the app's hooks and may fill the store opened here.
 */
export type LeadingBeforeOperation<Args> = (args: Args) => undefined;

export type CollectionLifecycleHooks = Partial<
  Pick<
    CollectionHooks,
    "afterChange" | "afterError" | "afterOperation" | "beforeChange" | "beforeOperation"
  >
> & {
  leadingBeforeOperation?: LeadingBeforeOperation<Parameters<CollectionBeforeOperationHook>[0]>;
};

export type GlobalLifecycleHooks = Partial<
  Pick<GlobalHooks, "afterChange" | "beforeChange" | "beforeOperation">
> & {
  leadingBeforeOperation?: LeadingBeforeOperation<Parameters<GlobalBeforeOperationHook>[0]>;
};

/**
 * Owned by the lifecycle thread through src/lifecycle/index.ts. Core calls
 * `requiredWriteActions` from the create and update access wrappers and holds the write
 * when every returned action that applies to the resource is granted. Returning a superset
 * is always safe. Returning less than the interim rule is safe only when the hooks returned
 * here enforce the difference. Core appends these hooks after the app's and after its own,
 * except `leadingBeforeOperation`, which runs inside core's first `beforeOperation` hook.
 */
export type LifecycleModule = {
  /** False while the interim rule stands. Surfaced in the startup log. */
  enforcing: boolean;
  requiredWriteActions: (args: WriteAccessArgs) => ReadonlySet<ActionId>;
  collectionHooks: (resource: Resource, enforcer: Enforcer) => CollectionLifecycleHooks;
  globalHooks: (resource: Resource, enforcer: Enforcer) => GlobalLifecycleHooks;
};

type EditSlots = NonNullable<NonNullable<CollectionConfig["admin"]>["components"]>["edit"];
type GlobalElements = NonNullable<NonNullable<GlobalConfig["admin"]>["components"]>["elements"];
type JsonFieldComponents = NonNullable<JSONField["admin"]>["components"];

/**
 * Owned by the matrix thread through src/admin/index.ts. Server components recover the
 * enforcer with `enforcerOf(payload)` and the editor with `enforcer.subject(req)`, where
 * `req` is the request object, never the field-filtered `user` prop.
 */
export type AdminModule = {
  /** `undefined` keeps Payload's stock JSON editor. */
  permissionsField: JsonFieldComponents | undefined;
  collectionEdit: (resource: Resource) => EditSlots | undefined;
  globalElements: (resource: Resource) => GlobalElements | undefined;
};

const isEnforcer = (value: unknown): value is Enforcer =>
  typeof value === "object" &&
  value !== null &&
  "subject" in value &&
  typeof value.subject === "function" &&
  "registry" in value &&
  value.registry instanceof Map &&
  "options" in value &&
  typeof value.options === "object";

/** Throws when the plugin is not registered on this Payload instance. */
export const enforcerOf = (payload: Payload): Enforcer => {
  const candidate: unknown = payload.config.custom?.[PLUGIN_SLUG];
  if (!isEnforcer(candidate)) {
    throw new Error(`${PLUGIN_SLUG} is not registered on this Payload config.`);
  }
  return candidate;
};
