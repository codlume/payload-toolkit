import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CollectionBeforeChangeHook,
  CollectionBeforeDeleteHook,
  CollectionBeforeOperationHook,
  CollectionConfig,
  GlobalConfig,
  Payload,
  PayloadRequest,
} from "payload";
import { Forbidden, ValidationError } from "payload";

import type {
  Capabilities,
  CollectionLifecycleHooks,
  Enforcer,
  GlobalLifecycleHooks,
  Grants,
  LeadingBeforeOperation,
  ResolvedOptions,
  SubjectId,
} from "./contract.ts";
import { NO_CAPABILITIES, parsePermissions, unionGrants } from "./grants.ts";
import {
  type Decision,
  decideRoleDelete,
  decideRoleWrite,
  decideUserDelete,
  decideUserWrite,
  type ForbiddenReason,
  removesSuperAdmin,
  SENSITIVE_KEYS,
  type UserTarget,
} from "./guards.ts";
import { loadRoleGrants, normalizeRoleIds } from "./resolve.ts";
import { CLAIM_SENTINEL } from "./schema.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isId = (value: unknown): value is SubjectId =>
  typeof value === "string" || typeof value === "number";

/**
 * A write is trusted only when access is overridden on a request that never left the
 * process. Payload's first-register runs `create({ overrideAccess: true })` on the anonymous
 * HTTP request, so `overrideAccess` alone cannot vouch for the body.
 */
export const isTrusted = (overrideAccess: boolean | undefined, req: PayloadRequest) =>
  overrideAccess === true && req.payloadAPI === "local";

/**
 * What `beforeOperation` records for the per-document hooks of one operation. The record
 * travels in an AsyncLocalStorage, so a nested operation and each document of a bulk
 * operation see their own operation's record (G1). A missing record is untrusted.
 */
type Operation = {
  trusted: boolean;
  /** The privileged keys as the client sent them, before Payload coerces or strips them. */
  raw: Readonly<Record<string, unknown>>;
  /** Active super admins before the operation, counted once per operation. */
  superAdmins: null | Promise<number>;
  /** Active super admins this operation has already let go, so a bulk cannot remove them all. */
  removed: number;
};

const operations = new AsyncLocalStorage<Operation>();

const untrusted = (): Operation => ({ trusted: false, raw: {}, superAdmins: null, removed: 0 });

const RECORDED_OPERATIONS = new Set(["create", "update", "delete", "restoreVersion"]);

const pick = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  const source = isRecord(value) ? value : {};
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]),
  );
};

type CollectionOperationArgs = Parameters<CollectionBeforeOperationHook>[0];

/**
 * Runs inside the opener, so `enterWith` happens before any hook awaits and the record reaches
 * the operation's own continuation. It does no lookups and makes no decisions: Payload has not
 * checked access or validated the query yet.
 */
const createRecorder =
  (keys: readonly string[]): LeadingBeforeOperation<CollectionOperationArgs> =>
  ({ args, operation, overrideAccess, req }) => {
    if (RECORDED_OPERATIONS.has(operation)) {
      const source: unknown = args;
      const data = isRecord(source) ? source.data : undefined;
      operations.enterWith({
        trusted: isTrusted(overrideAccess, req),
        raw: pick(data, keys),
        superAdmins: null,
        removed: 0,
      });
    }
    return undefined;
  };

/**
 * The first `beforeOperation` hook. Payload awaits each hook in turn, so only an `enterWith`
 * made in the first one reaches the operation's later hooks. Core records, then the
 * lifecycle's leading callback runs, both synchronously; `undefined` keeps Payload's args.
 */
const createOpener = <Args>(
  record: LeadingBeforeOperation<Args> | undefined,
  lead: LeadingBeforeOperation<Args> | undefined,
): LeadingBeforeOperation<Args>[] =>
  record || lead
    ? [
        (args) => {
          record?.(args);
          lead?.(args);
          return undefined;
        },
      ]
    : [];

type Editor = { capabilities: Capabilities; id: null | SubjectId };

type GuardContext = {
  enforcer: Enforcer;
  req: PayloadRequest;
  editor: Editor;
  operation: string;
  slug: string;
};

const guardContext = async (
  enforcer: Enforcer,
  req: PayloadRequest,
  slug: string,
  operation: string,
): Promise<GuardContext> => {
  const subject = await enforcer.subject(req);
  return {
    enforcer,
    req,
    slug,
    operation,
    editor:
      subject.kind === "member"
        ? { capabilities: subject.capabilities, id: subject.id }
        : { capabilities: NO_CAPABILITIES, id: null },
  };
};

/** A function declaration, so a bare call narrows the caller's types like a `throw`. */
function refuse(reason: ForbiddenReason, { enforcer, req, operation, slug }: GuardContext): never {
  enforcer.log.debug(req.payload, "guard_denied", { collection: slug, operation, reason });
  throw new Forbidden(req.t);
}

const throwDecision = (decision: Decision, ctx: GuardContext) => {
  if (decision.kind === "forbidden") {
    refuse(decision.reason, ctx);
  }
  if (decision.kind === "invalid") {
    ctx.enforcer.log.debug(ctx.req.payload, "guard_denied", {
      collection: ctx.slug,
      operation: ctx.operation,
      errors: decision.errors,
    });
    throw new ValidationError({ collection: ctx.slug, errors: [...decision.errors], req: ctx.req });
  }
};

/** The stored row, with no hooks and no access, inside the request's transaction. */
const findRow = async (ctx: GuardContext, id: null | SubjectId) => {
  if (id === null) {
    return null;
  }
  const row: unknown = await ctx.req.payload.db.findOne({
    collection: ctx.slug,
    req: ctx.req,
    where: { id: { equals: id } },
  });
  return isRecord(row) ? row : null;
};

/** Payload hands the document an update is about to write to `beforeChange` as `originalDoc`. */
const idOf = (doc: unknown): null | SubjectId => (isRecord(doc) && isId(doc.id) ? doc.id : null);

const isTrashed = (doc: Record<string, unknown>) =>
  doc.deletedAt !== undefined && doc.deletedAt !== null;

/**
 * Active super admins before this operation, counted once and shared by every document the
 * operation touches. Payload's `count` fails inside Mongo replica-set transactions (G14).
 */
const superAdminsBefore = (ctx: GuardContext, operation: Operation): Promise<number> => {
  operation.superAdmins ??= ctx.req.payload.db
    .find({
      collection: ctx.slug,
      limit: 0,
      pagination: false,
      req: ctx.req,
      where: { [ctx.enforcer.options.superAdminField]: { equals: true } },
    })
    .then(({ docs }) => docs.filter((doc) => isRecord(doc) && !isTrashed(doc)).length);
  return operation.superAdmins;
};

const uniqueIds = (ids: Iterable<SubjectId>) => {
  const seen = new Map<string, SubjectId>();
  for (const id of ids) {
    seen.set(String(id), id);
  }
  return [...seen.values()];
};

const toTarget = (
  ctx: GuardContext,
  row: Record<string, unknown>,
  roleGrants: ReadonlyMap<string, Grants>,
): null | UserTarget => {
  const { rolesField, superAdminField } = ctx.enforcer.options;
  if (!isId(row.id)) {
    return null;
  }
  const superAdmin = row[superAdminField] === true;
  const roleIds = normalizeRoleIds(row[rolesField]);
  const grants = roleIds.map((id) => roleGrants.get(String(id))).filter((g) => g !== undefined);
  return {
    id: row.id,
    superAdmin,
    trashed: isTrashed(row),
    roleIds,
    capabilities: superAdmin ? { kind: "all" } : { kind: "grants", grants: unionGrants(grants) },
    doc: row,
  };
};

const userKeys = (options: ResolvedOptions): readonly string[] => [
  options.rolesField,
  options.superAdminField,
  ...SENSITIVE_KEYS,
];

/**
 * Judges a create, duplicate, update or restore of one user after Payload's access check and
 * field access. The body judged is the privileged keys as the client sent them over the data
 * Payload is about to write, so neither coercion nor silent field-access stripping can hide
 * an attempt. The target is its stored row, not what `afterRead` hooks show.
 */
const createUsersWriteGuard =
  (enforcer: Enforcer): CollectionBeforeChangeHook =>
  async ({ data, operation, originalDoc, req }) => {
    const current = operations.getStore() ?? untrusted();
    if (current.trusted) {
      return data;
    }
    const { options } = enforcer;
    const ctx = await guardContext(enforcer, req, options.userCollection, operation);
    const judged = { ...pick(data, userKeys(options)), ...current.raw };
    const row = operation === "update" ? await findRow(ctx, idOf(originalDoc)) : null;
    const roleGrants = await loadRoleGrants(
      enforcer,
      req.payload,
      req,
      uniqueIds([
        ...normalizeRoleIds(row?.[options.rolesField]),
        ...normalizeRoleIds(judged[options.rolesField]),
      ]),
    );
    const target = row ? toTarget(ctx, row, roleGrants) : null;
    if (operation === "update" && !target) {
      refuse("target-missing", ctx);
    }
    const removal = target !== null && removesSuperAdmin(judged, target, options);
    const superAdminCount = removal ? (await superAdminsBefore(ctx, current)) - current.removed : 0;
    throwDecision(
      decideUserWrite({
        editor: ctx.editor.capabilities,
        editorId: ctx.editor.id,
        raw: judged,
        target,
        roleGrants,
        superAdminCount,
        fields: options,
      }),
      ctx,
    );
    if (removal) {
      current.removed += 1;
    }
    return data;
  };

/** Judges the delete of one user, by id or as one document of a bulk delete. */
const createUsersDeleteGuard =
  (enforcer: Enforcer): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const current = operations.getStore() ?? untrusted();
    if (current.trusted) {
      return;
    }
    const { options } = enforcer;
    const ctx = await guardContext(enforcer, req, options.userCollection, "delete");
    const row = await findRow(ctx, id);
    const roleGrants = await loadRoleGrants(
      enforcer,
      req.payload,
      req,
      normalizeRoleIds(row?.[options.rolesField]),
    );
    const target = row ? toTarget(ctx, row, roleGrants) : null;
    if (!target) {
      refuse("target-missing", ctx);
    }
    const removal = target.superAdmin && !target.trashed;
    const superAdminCount = removal ? (await superAdminsBefore(ctx, current)) - current.removed : 0;
    throwDecision(
      decideUserDelete({ editor: ctx.editor.capabilities, target, superAdminCount }),
      ctx,
    );
    if (removal) {
      current.removed += 1;
    }
  };

/**
 * Judges a create, duplicate, update or restore of one role. The stored permissions are
 * rewritten to their canonical form when the client sent any.
 */
const createRolesWriteGuard =
  (enforcer: Enforcer): CollectionBeforeChangeHook =>
  async ({ data, operation, originalDoc, req }) => {
    const current = operations.getStore() ?? untrusted();
    if (current.trusted) {
      return data;
    }
    const { permissionsField, rolesSlug } = enforcer.options;
    const ctx = await guardContext(enforcer, req, rolesSlug, operation);
    const row = operation === "update" ? await findRow(ctx, idOf(originalDoc)) : null;
    if (operation === "update" && !row) {
      refuse("target-missing", ctx);
    }
    const { decision, canonical } = decideRoleWrite({
      editor: ctx.editor.capabilities,
      raw: { ...pick(data, [permissionsField, "key"]), ...current.raw },
      targetKey: typeof row?.key === "string" ? row.key : null,
      current: row ? parsePermissions(row[permissionsField], enforcer.registry).grants : null,
      registry: enforcer.registry,
      permissionsField,
    });
    throwDecision(decision, ctx);
    return canonical && permissionsField in current.raw && isRecord(data)
      ? { ...data, [permissionsField]: canonical }
      : data;
  };

/** Judges the delete of one role, by id or as one document of a bulk delete. */
const createRolesDeleteGuard =
  (enforcer: Enforcer): CollectionBeforeDeleteHook =>
  async ({ id, req }) => {
    const current = operations.getStore() ?? untrusted();
    if (current.trusted) {
      return;
    }
    const { permissionsField, rolesSlug } = enforcer.options;
    const ctx = await guardContext(enforcer, req, rolesSlug, "delete");
    const row = await findRow(ctx, id);
    if (!row) {
      refuse("target-missing", ctx);
    }
    throwDecision(
      decideRoleDelete(
        ctx.editor.capabilities,
        parsePermissions(row[permissionsField], enforcer.registry).grants,
      ),
      ctx,
    );
  };

/**
 * A user created while the user collection is empty becomes a super admin, again if every user
 * is ever removed. The claim is written in the same insert on a unique column, so two
 * concurrent first registrations cannot both win.
 * `db.findOne` instead of `count`, which fails inside Mongo replica-set transactions.
 */
const createBootstrapHook =
  (enforcer: Enforcer): CollectionBeforeChangeHook =>
  async ({ data, operation, req }) => {
    const { claimField, superAdminField, userCollection } = enforcer.options;
    if (operation === "create") {
      const existing = await req.payload.db.findOne({ collection: userCollection, where: {}, req });
      if (!existing) {
        enforcer.log.debug(req.payload, "bootstrap_claimed", { collection: userCollection });
        return { ...data, [superAdminField]: true, [claimField]: CLAIM_SENTINEL };
      }
    }
    if (claimField in data) {
      const stripped: Record<string, unknown> = { ...data };
      delete stripped[claimField];
      return stripped;
    }
    return data;
  };

type CollectionHooks = NonNullable<CollectionConfig["hooks"]>;

export type CoreCollectionHooks = Partial<
  Pick<CollectionHooks, "beforeChange" | "beforeDelete">
> & {
  record?: LeadingBeforeOperation<CollectionOperationArgs>;
};

/**
 * Core's hooks for one collection. The users collection gets the recorder, the write and
 * delete guards and the bootstrap; the roles collection gets the recorder and its guards.
 * Disabled mode keeps only the bootstrap.
 */
export const createCoreHooks = (enforcer: Enforcer, slug: string): CoreCollectionHooks => {
  const { options } = enforcer;
  if (slug === options.userCollection) {
    return {
      ...(options.enabled && { record: createRecorder(userKeys(options)) }),
      beforeChange: [
        ...(options.enabled ? [createUsersWriteGuard(enforcer)] : []),
        createBootstrapHook(enforcer),
      ],
      beforeDelete: options.enabled ? [createUsersDeleteGuard(enforcer)] : [],
    };
  }
  if (slug === options.rolesSlug && options.enabled) {
    return {
      record: createRecorder([options.permissionsField, "key"]),
      beforeChange: [createRolesWriteGuard(enforcer)],
      beforeDelete: [createRolesDeleteGuard(enforcer)],
    };
  }
  return {};
};

type CollectionHookKey =
  | "beforeDelete"
  | Exclude<keyof CollectionLifecycleHooks, "leadingBeforeOperation">;
type GlobalHookKey = Exclude<keyof GlobalLifecycleHooks, "leadingBeforeOperation">;

/** How many of the plugin's hooks lead and trail the app's on one key. */
type Placement = { leading: number; trailing: number };

type Installed<Key extends string> = Map<string, Map<Key, Placement>>;

const problem = (id: string, key: string) =>
  `Hooks were placed around the roles plugin's own on "${id}" \`${key}\` after it ran. Register rolesPlugin after every plugin that adds hooks there.`;

/**
 * Orders hooks as `[...leading, ...app, ...trailing]` and remembers which ones are ours, so
 * `verify` can prove at init that no later plugin moved a hook in front of or behind them.
 * The opener leads `beforeOperation`; everything else of core's and the lifecycle's trails.
 */
export const createHookTracker = () => {
  const ours = new WeakSet<object>();
  const collections: Installed<CollectionHookKey> = new Map();
  const globals: Installed<GlobalHookKey> = new Map();

  const place = <Key extends string, Hook extends object>(
    installed: Installed<Key>,
    slug: string,
    key: Key,
    leading: readonly Hook[],
    app: readonly Hook[] | undefined,
    trailing: readonly Hook[],
  ): Hook[] => {
    for (const hook of [...leading, ...trailing]) {
      ours.add(hook);
    }
    const perKey = installed.get(slug) ?? new Map<Key, Placement>();
    perKey.set(key, { leading: leading.length, trailing: trailing.length });
    installed.set(slug, perKey);
    return [...leading, ...(app ?? []), ...trailing];
  };

  const collection = (
    slug: string,
    app: CollectionConfig["hooks"],
    core: CoreCollectionHooks,
    lifecycle: CollectionLifecycleHooks,
  ): CollectionHooks => ({
    ...app,
    beforeOperation: place(
      collections,
      slug,
      "beforeOperation",
      createOpener(core.record, lifecycle.leadingBeforeOperation),
      app?.beforeOperation,
      lifecycle.beforeOperation ?? [],
    ),
    beforeChange: place(collections, slug, "beforeChange", [], app?.beforeChange, [
      ...(core.beforeChange ?? []),
      ...(lifecycle.beforeChange ?? []),
    ]),
    beforeDelete: place(
      collections,
      slug,
      "beforeDelete",
      [],
      app?.beforeDelete,
      core.beforeDelete ?? [],
    ),
    afterOperation: place(
      collections,
      slug,
      "afterOperation",
      [],
      app?.afterOperation,
      lifecycle.afterOperation ?? [],
    ),
    afterChange: place(
      collections,
      slug,
      "afterChange",
      [],
      app?.afterChange,
      lifecycle.afterChange ?? [],
    ),
    afterError: place(
      collections,
      slug,
      "afterError",
      [],
      app?.afterError,
      lifecycle.afterError ?? [],
    ),
  });

  const global = (
    slug: string,
    app: GlobalConfig["hooks"],
    lifecycle: GlobalLifecycleHooks,
  ): NonNullable<GlobalConfig["hooks"]> => ({
    ...app,
    beforeOperation: place(
      globals,
      slug,
      "beforeOperation",
      createOpener(undefined, lifecycle.leadingBeforeOperation),
      app?.beforeOperation,
      lifecycle.beforeOperation ?? [],
    ),
    beforeChange: place(
      globals,
      slug,
      "beforeChange",
      [],
      app?.beforeChange,
      lifecycle.beforeChange ?? [],
    ),
    afterChange: place(
      globals,
      slug,
      "afterChange",
      [],
      app?.afterChange,
      lifecycle.afterChange ?? [],
    ),
  });

  const inPlace = (list: readonly object[] | undefined, { leading, trailing }: Placement) => {
    const hooks = list ?? [];
    return (
      hooks.length >= leading + trailing &&
      hooks.slice(0, leading).every((hook) => ours.has(hook)) &&
      (trailing === 0 || hooks.slice(-trailing).every((hook) => ours.has(hook)))
    );
  };

  const verify = (payload: Payload): string[] => {
    const problems: string[] = [];
    for (const [slug, perKey] of collections) {
      const hooks = payload.collections[slug]?.config.hooks;
      for (const [key, placement] of perKey) {
        if (!inPlace(hooks?.[key], placement)) {
          problems.push(problem(`collections:${slug}`, key));
        }
      }
    }
    for (const [slug, perKey] of globals) {
      const hooks = payload.globals.config.find((config) => config.slug === slug)?.hooks;
      for (const [key, placement] of perKey) {
        if (!inPlace(hooks?.[key], placement)) {
          problems.push(problem(`globals:${slug}`, key));
        }
      }
    }
    return problems;
  };

  return { collection, global, verify };
};
