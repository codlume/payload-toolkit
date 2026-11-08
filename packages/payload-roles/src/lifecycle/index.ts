import { AsyncLocalStorage } from "node:async_hooks";

import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  DefaultDocumentIDType,
  GlobalBeforeChangeHook,
  GlobalBeforeOperationHook,
  PayloadRequest,
  SanitizedGlobalConfig,
} from "payload";
import { combineQueries, executeAccess, Forbidden, NotFound } from "payload";

import type {
  ActionId,
  Enforcer,
  LifecycleModule,
  Resource,
  ResourceId,
  WriteAccessArgs,
} from "../contract.ts";
import { can } from "../grants.ts";
import { sameId } from "../resolve.ts";
import {
  judge,
  type RequestView,
  requestFacts,
  requiredActions,
  settleAfter,
  settleBefore,
  STATUS,
} from "./rules.ts";

type Kind = RequestView["kind"];

type Holds = (action: ActionId) => boolean;

type Plan =
  | { readonly kind: "exempt" }
  | {
      readonly kind: "enforce";
      readonly view: RequestView;
      /**
       * Pinned when planned, so a nested Local call that rewrites `req.user`
       * (utilities/createLocalReq.js:91) cannot change whose write is judged.
       */
      readonly holdsFor: (target: unknown) => Holds;
    };

/**
 * Opened by `open` in core's first `beforeOperation` hook, the only `enterWith` that reaches the
 * operation's later hooks (G1).
 */
type Frame = {
  readonly resource: ResourceId;
  readonly kind: Kind;
  readonly trusted: boolean;
  /** `Object.keys(args.data)` as the client sent it, before app hooks and field fills (G3, G7). */
  readonly bodyKeys: readonly string[];
  /** The raw `draft` flag. Restore reads it before any hook runs (restoreVersion.js:24). */
  readonly draft: boolean;
  plan: null | Plan;
};

const frames = new AsyncLocalStorage<Frame>();

const KINDS: Readonly<Record<string, Kind>> = {
  create: "create",
  restoreVersion: "restore",
  update: "update",
};

const LIFECYCLE_KEYS: ReadonlySet<string> = new Set(["_status", "deletedAt"]);

/** `create` access serves create and duplicate; `update` access serves update and restore. */
const servesKey = (kind: Kind, key: WriteAccessArgs["key"]) =>
  key === "create" ? kind === "create" : kind !== "create";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isId = (value: unknown): value is DefaultDocumentIDType =>
  typeof value === "string" || typeof value === "number";

const idOf = (doc: unknown) => (isRecord(doc) && isId(doc.id) ? doc.id : null);

type Reason = "denied" | "intent-missing" | "target-missing";

/** A function declaration, so a bare call narrows like a `throw`. */
function refuse(
  enforcer: Enforcer,
  req: PayloadRequest,
  resource: Resource,
  reason: Reason,
  missing: readonly ActionId[],
): never {
  const log = reason === "intent-missing" ? enforcer.log.error : enforcer.log.debug;
  log(req.payload, "lifecycle_denied", { resource: resource.id, reason, missing });
  throw new Forbidden(req.t);
}

type OpenArgs = { args?: unknown; operation: string; overrideAccess?: boolean | undefined };

const open =
  (resource: Resource) =>
  ({ args, operation, overrideAccess }: OpenArgs): undefined => {
    const kind = KINDS[operation];
    if (kind !== undefined) {
      const source = isRecord(args) ? args : {};
      frames.enterWith({
        resource: resource.id,
        kind,
        trusted: overrideAccess === true,
        bodyKeys: isRecord(source.data) ? Object.keys(source.data) : [],
        draft: Boolean(source.draft),
        plan: null,
      });
    }
  };

const ownFrame = (enforcer: Enforcer, req: PayloadRequest, resource: Resource, kind: Kind) => {
  const frame = frames.getStore();
  if (
    frame === undefined ||
    frame.resource !== resource.id ||
    frame.kind !== kind ||
    frame.plan !== null
  ) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  return frame;
};

/** Truthiness, because Payload branches on it. */
const viewOf = (frame: Frame, source: Record<string, unknown>, files: boolean): RequestView => ({
  kind: frame.kind,
  duplicate: frame.kind === "create" && source.duplicateFromID !== undefined,
  bodyKeys: frame.bodyKeys,
  files,
  draft: frame.kind === "restore" ? frame.draft : Boolean(source.draft),
  trash: Boolean(source.trash),
  data: isRecord(source.data) ? source.data : undefined,
});

type Files = (frame: Frame, source: Record<string, unknown>) => boolean;

type PlanArgs = {
  resource: Resource;
  enforcer: Enforcer;
  operation: string;
  args: unknown;
  req: PayloadRequest;
  files: Files;
};

const plan = async ({ resource, enforcer, operation, args, req, files }: PlanArgs) => {
  const kind = KINDS[operation];
  if (kind === undefined) {
    return;
  }
  const frame = ownFrame(enforcer, req, resource, kind);
  if (frame.trusted) {
    frame.plan = { kind: "exempt" };
    return;
  }
  const subject = await enforcer.subject(req);
  if (subject.kind === "outsider" || subject.capabilities.kind === "all") {
    frame.plan = { kind: "exempt" };
    return;
  }
  const { capabilities, id: subjectId } = subject;
  const self = resource.slug === enforcer.options.userCollection;
  const holdsFor =
    (target: unknown): Holds =>
    (action) =>
      can(capabilities, resource.id, action) ||
      (action === "update" && self && isId(target) && sameId(target, subjectId));
  const source = isRecord(args) ? args : {};
  const view = viewOf(frame, source, kind === "update" && files(frame, source));
  const verdict = judge(
    resource,
    requestFacts(resource, view),
    holdsFor(kind === "update" ? source.id : undefined),
  );
  // Payload deletes and writes an upload's files before beforeChange (G18), so such an update
  // must hold every possibility now.
  if (verdict.kind === "deny" || (view.files && verdict.kind !== "allow")) {
    refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
  }
  frame.plan = { kind: "enforce", view, holdsFor };
};

type Row = Readonly<Record<string, unknown>>;

type CheckArgs = {
  resource: Resource;
  enforcer: Enforcer;
  operation: "create" | "update";
  data: Row;
  originalDoc: unknown;
  req: PayloadRequest;
  readRow: () => Promise<null | Row>;
};

const check = async ({
  resource,
  enforcer,
  operation,
  data,
  originalDoc,
  req,
  readRow,
}: CheckArgs) => {
  const frame = frames.getStore();
  if (
    frame === undefined ||
    frame.resource !== resource.id ||
    !servesKey(frame.kind, operation) ||
    frame.plan === null
  ) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  const current = frame.plan;
  if (current.kind === "exempt") {
    return;
  }
  const holds = current.holdsFor(operation === "update" ? idOf(originalDoc) : undefined);
  const facts = settleAfter(resource, requestFacts(resource, current.view), data);
  let verdict = judge(resource, facts, holds);
  if (verdict.kind === "depends") {
    const row = await readRow();
    if (row === null) {
      refuse(enforcer, req, resource, "target-missing", []);
    }
    verdict = judge(resource, settleBefore(resource, facts, row), holds);
  }
  if (verdict.kind !== "allow") {
    refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
  }
};

type GlobalRestoreArgs = {
  resource: Resource;
  enforcer: Enforcer;
  global: SanitizedGlobalConfig;
  args: unknown;
  req: PayloadRequest;
};

/**
 * Global restore runs no beforeChange (G4), so it is decided whole here. The steps mirror
 * Payload's own order and errors (globals/restoreVersion.js:36-53).
 */
const settleGlobalRestore = async ({
  resource,
  enforcer,
  global,
  args,
  req,
}: GlobalRestoreArgs) => {
  const frame = frames.getStore();
  if (
    frame === undefined ||
    frame.resource !== resource.id ||
    frame.kind !== "restore" ||
    frame.plan === null
  ) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  const current = frame.plan;
  if (current.kind === "exempt") {
    return;
  }
  const versionId = isRecord(args) ? args.id : undefined;
  if (!isId(versionId)) {
    throw new NotFound(req.t);
  }
  const access = await executeAccess({ req }, global.access.readVersions);
  const { docs } = await req.payload.db.findGlobalVersions({
    global: global.slug,
    limit: 1,
    req,
    where: combineQueries({ id: { equals: versionId } }, access),
  });
  const stored: unknown = docs[0]?.version;
  if (!isRecord(stored)) {
    throw typeof access === "object" ? new Forbidden(req.t) : new NotFound(req.t);
  }
  const row: unknown = await req.payload.db.findGlobal({ slug: global.slug, req });
  const facts = settleBefore(
    resource,
    settleAfter(resource, requestFacts(resource, current.view), {
      [STATUS]: current.view.draft ? "draft" : stored[STATUS],
    }),
    isRecord(row) ? row : {},
  );
  const verdict = judge(resource, facts, current.holdsFor(undefined));
  if (verdict.kind !== "allow") {
    refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
  }
};

/** An admin probe or `/access` call: no operation, so no client body and no flags. */
const probeView = (key: WriteAccessArgs["key"], data: WriteAccessArgs["data"]): RequestView => ({
  kind: key,
  duplicate: false,
  bodyKeys: null,
  files: false,
  draft: false,
  trash: false,
  data,
});

const requiredWriteActions = ({ resource, key, data }: WriteAccessArgs): ReadonlySet<ActionId> => {
  const frame = frames.getStore();
  const planned =
    frame !== undefined &&
    frame.resource === resource.id &&
    servesKey(frame.kind, key) &&
    frame.plan?.kind === "enforce"
      ? frame.plan.view
      : null;
  const view = planned === null ? probeView(key, data) : { ...planned, data };
  return requiredActions(resource, requestFacts(resource, view));
};

const governs = (resource: Resource) => resource.drafts || resource.trash || resource.versions;

/**
 * An upload update may touch stored files unless its body is lifecycle-only and it carries no
 * file and no crop or focal edit (`generateFileData.js:18-32,66,378`).
 */
const touchesFiles = (req: PayloadRequest, frame: Frame, source: Record<string, unknown>) => {
  const keys = [...frame.bodyKeys, ...(isRecord(source.data) ? Object.keys(source.data) : [])];
  return (
    req.file !== undefined ||
    req.query.uploadEdits !== undefined ||
    keys.length === 0 ||
    keys.some((key) => !LIFECYCLE_KEYS.has(key))
  );
};

const collectionHooks: LifecycleModule["collectionHooks"] = (resource, enforcer) => {
  if (!governs(resource)) {
    return {};
  }
  const trailing: CollectionBeforeOperationHook = async ({ args, collection, operation, req }) => {
    await plan({
      resource,
      enforcer,
      operation,
      args,
      req,
      files: (frame, source) => Boolean(collection.upload) && touchesFiles(req, frame, source),
    });
  };
  const beforeChange: CollectionBeforeChangeHook = async ({
    data,
    operation,
    originalDoc,
    req,
  }) => {
    await check({
      resource,
      enforcer,
      operation,
      data,
      originalDoc,
      req,
      // The main table only, trashed rows included.
      readRow: async () => {
        const id = idOf(originalDoc);
        if (id === null) {
          return null;
        }
        const row: unknown = await req.payload.db.findOne({
          collection: resource.slug,
          req,
          where: { id: { equals: id } },
        });
        return isRecord(row) ? row : null;
      },
    });
    return data;
  };
  return {
    leadingBeforeOperation: open(resource),
    beforeOperation: [trailing],
    beforeChange: [beforeChange],
  };
};

const globalHooks: LifecycleModule["globalHooks"] = (resource, enforcer) => {
  if (!governs(resource)) {
    return {};
  }
  const trailing: GlobalBeforeOperationHook = async ({ args, global, operation, req }) => {
    await plan({ resource, enforcer, operation, args, req, files: () => false });
    if (operation === "restoreVersion") {
      await settleGlobalRestore({ resource, enforcer, global, args, req });
    }
  };
  const beforeChange: GlobalBeforeChangeHook = async ({ data, req }) => {
    await check({
      resource,
      enforcer,
      operation: "update",
      data,
      originalDoc: undefined,
      req,
      // `{}` before the first save is a row: an unsaved global (@payloadcms/drizzle findGlobal.js).
      readRow: async () => {
        const row: unknown = await req.payload.db.findGlobal({ slug: resource.slug, req });
        return isRecord(row) ? row : null;
      },
    });
    return data;
  };
  return {
    leadingBeforeOperation: open(resource),
    beforeOperation: [trailing],
    beforeChange: [beforeChange],
  };
};

export const lifecycle: LifecycleModule = {
  enforcing: true,
  requiredWriteActions,
  collectionHooks,
  globalHooks,
};
