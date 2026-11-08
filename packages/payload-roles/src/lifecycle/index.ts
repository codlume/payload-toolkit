// The Payload adapter around ./rules.ts. It parses hook arguments into `RequestView`, carries one
// `Frame` per operation in its own AsyncLocalStorage, reads the main row when a verdict depends
// on it, and throws `Forbidden`. Every policy decision is a call into ./rules.ts. Nothing but
// `lifecycle` leaves this file, so the store cannot be reached from outside it.
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
  /** Trusted, an outsider, or a super admin: the lifecycle adds no denial. */
  | { readonly kind: "exempt" }
  | {
      readonly kind: "enforce";
      readonly view: RequestView;
      /**
       * Pinned when planned, so a nested Local call that rewrites `req.user` (payload-ops 0.7)
       * cannot change whose write is judged. `target` is the document id for the self-edit
       * carve-out on the user collection.
       */
      readonly holdsFor: (target: unknown) => Holds;
    };

/**
 * One write operation's record. Opened by `open` in core's first `beforeOperation` hook, the
 * only `enterWith` that reaches the operation's later hooks (G1), so a nested operation and every
 * document of a bulk see their own operation's frame and never another's. `plan` has one writer,
 * the trailing `beforeOperation` hook, which sets it once; access and `beforeChange` only read it.
 */
type Frame = {
  readonly resource: ResourceId;
  readonly kind: Kind;
  /** Payload's contract, `overrideAccess === true`; wider than core's `isTrusted`. */
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
  // A missing frame means a write path skipped the opener, an invariant break worth surfacing.
  const log = reason === "intent-missing" ? enforcer.log.error : enforcer.log.debug;
  log(req.payload, "lifecycle_denied", { resource: resource.id, reason, missing });
  throw new Forbidden(req.t);
}

type OpenArgs = { args?: unknown; operation: string; overrideAccess?: boolean | undefined };

/**
 * `leadingBeforeOperation`. Synchronous and decision-free, because Payload has not checked access
 * yet. Reads and deletes keep whatever frame is current, which only write hooks of the same
 * resource and kind ever consult.
 */
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

/**
 * The frame `open` made for this very operation. An unplanned frame for this resource and kind
 * can only be this operation's: an outer operation's frame was planned before its access ran,
 * and every write opens its own.
 */
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

/** Boundary parse of Payload's operation args. Truthiness, because Payload branches on it. */
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
  /** Upload collections only: whether this update may write stored files before beforeChange. */
  files: Files;
};

/**
 * The trailing `beforeOperation` hook body, after every app hook, so it sees the args Payload
 * acts on. Pins the subject, runs the pre-access check and stores the plan. The check reads
 * nothing stored, so its denial says nothing about any document.
 */
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
  // Core's self-edit carve-out (access.ts `rolesSide`): a member may update their own user
  // document without `update`. Every other grant still applies to it.
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
  // must hold every possibility now. Otherwise only what no possibility allows is refused.
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
  /** The stored main row this write replaces. `null` when the document is gone. */
  readRow: () => Promise<null | Row>;
};

/**
 * The trailing `beforeChange` hook body, once per document. Judges the data Payload is about to
 * write and reads the main row only when the verdict depends on it: never for a draft save, an
 * autosave or a create, and never when the editor holds every possibility or none.
 */
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
 * Global restore runs no beforeChange (payload-ops 9.2), so it is decided whole here, right
 * after `plan`. The steps mirror Payload's own order and errors (globals/restoreVersion.js:36-53),
 * so nothing stored is read before the editor passed the same readVersions access Payload is
 * about to run. Races a concurrent writer like every main-row read (G2).
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

/**
 * Called by core's create and update access wrappers for members, for real writes and for admin
 * probes. Inside a planned write of this resource it uses the plan's write class and the access
 * call's `data` (for a restore, Payload's `{ _status }` of the version). Outside one it is a
 * probe: no client body, any untrashed row, so `{ ...doc, _status: "draft" }` asks for `update`
 * and `{ ...doc, _status: "published" }` for `update + publish`.
 */
const requiredWriteActions = ({ resource, key, data }: WriteAccessArgs): ReadonlySet<ActionId> => {
  const frame = frames.getStore();
  const planned =
    frame !== undefined &&
    frame.resource === resource.id &&
    servesKey(frame.kind, key) &&
    frame.plan?.kind === "enforce"
      ? frame.plan.view
      : null;
  const view: RequestView =
    planned === null
      ? {
          kind: key,
          duplicate: false,
          bodyKeys: null,
          files: false,
          draft: false,
          trash: false,
          data,
        }
      : { ...planned, data };
  return requiredActions(resource, requestFacts(resource, view));
};

/** Drafts, trash or versions: otherwise no lifecycle action applies and the floor is the key. */
const governs = (resource: Resource) => resource.drafts || resource.trash || resource.versions;

/**
 * An upload update may touch stored files unless its body is lifecycle-only and it carries no
 * file and no crop or focal edit (`generateFileData.js:18-32,66,378`). The client's keys and the
 * post-hook keys both count, so an app hook cannot add content behind the check.
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
      // The main table only, trashed rows included (payload-ops 14a).
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
      // `{}` before the first save is a row: an unsaved global (payload-ops 14c).
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
