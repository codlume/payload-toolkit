import type {
  CollectionBeforeChangeHook,
  CollectionBeforeOperationHook,
  DefaultDocumentIDType,
  GlobalBeforeChangeHook,
  GlobalBeforeOperationHook,
  PayloadRequest,
  SanitizedGlobalConfig,
  SelectIncludeType,
} from "payload";
import { combineQueries, executeAccess, Forbidden, NotFound } from "payload";

import type {
  ActionId,
  Enforcer,
  LifecycleModule,
  Resource,
  WriteAccessArgs,
} from "../contract.ts";
import { can } from "../grants.ts";
import { sameId } from "../resolve.ts";
import {
  createOperationScope,
  type OperationTarget,
  operationKind,
  requestKeyOf,
} from "../scope.ts";
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
  /** Planned while every covering frame was trusted; it carries nothing to judge it by. */
  | { readonly kind: "trusted" }
  /** An outsider or a super admin: app access alone decides. */
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
 * One operation's record, opened through core's operation scope in core's first `beforeOperation`
 * hook (G1). The scope links it to the entry it replaces and finds every entry that covers a
 * document under the same request, so a trusted operation an app hook starts synchronously
 * cannot stand in for the outer member write.
 */
type Frame = {
  readonly kind: Kind;
  /** This operation's own `overrideAccess === true`, as the scope entry records it. */
  readonly trusted: boolean;
  /** `Object.keys(args.data)` as the client sent it, before app hooks and field fills (G3, G7). */
  readonly bodyKeys: readonly string[];
  /** The raw `draft` flag. Restore reads it before any hook runs (restoreVersion.js:24). */
  readonly draft: boolean;
  plan: null | Plan;
};

const frames = createOperationScope<Frame>();

const KINDS: Readonly<Record<string, Kind>> = {
  create: "create",
  restoreVersion: "restore",
  update: "update",
};

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

/**
 * The documents an operation writes. Only an update by id names its document; a create, a bulk
 * write, a restore (whose `args.id` is the version's) and every global write cover them all.
 */
const targetOf = (resource: Resource, operation: string, args: unknown): null | OperationTarget => {
  const kind = operationKind(operation);
  if (kind === undefined || KINDS[operation] === undefined) {
    return null;
  }
  const id = isRecord(args) ? args.id : undefined;
  return {
    collection: resource.id,
    kind,
    id: resource.kind === "collection" && operation === "update" && isId(id) ? id : undefined,
  };
};

type OpenArgs = {
  args?: unknown;
  operation: string;
  overrideAccess?: boolean | undefined;
  req: PayloadRequest;
};

/**
 * Where `open` leaves each operation's `settle` on the args object Payload passes to its hooks.
 * An enumerable symbol key survives an app hook that returns `{ ...args }`, so the trailing hook
 * still finds it; a freshly built args object loses it, and `widen` covers that case.
 */
const SETTLE = Symbol("payload-roles.lifecycle.settle");

const open =
  (resource: Resource) =>
  ({ args, operation, overrideAccess, req }: OpenArgs): undefined => {
    const kind = KINDS[operation];
    const target = targetOf(resource, operation, args);
    if (kind !== undefined && target !== null) {
      const source = isRecord(args) ? args : {};
      const trusted = overrideAccess === true;
      const settle = frames.open(target, requestKeyOf(req), trusted, {
        kind,
        trusted,
        bodyKeys: isRecord(source.data) ? Object.keys(source.data) : [],
        draft: Boolean(source.draft),
        plan: null,
      });
      if (isRecord(args)) {
        Reflect.set(args, SETTLE, settle);
      }
    }
  };

/**
 * Records the id Payload will act on, which an app `beforeOperation` hook may have rewritten (an
 * alias, say), so a trusted frame names its real document. Then, as core does, widens every other
 * unsettled frame of this collection and kind that names another document, in case the settle
 * found was not this operation's own: widening never narrows, so it can only add to a judgement.
 */
const settleTarget = (args: unknown, target: OperationTarget, req: PayloadRequest) => {
  const settle: unknown = isRecord(args) ? Reflect.get(args, SETTLE) : undefined;
  if (typeof settle === "function" && isRecord(args)) {
    Reflect.deleteProperty(args, SETTLE);
    Reflect.apply(settle, undefined, [target.id]);
  }
  frames.widen(target.collection, target.kind, requestKeyOf(req), target.id);
};

/**
 * The frames that may write `document` under this request, innermost first. Trust is the scope's
 * own verdict: an untrusted entry lowers it for every document of its collection and kind, because
 * the id it was opened with can name this document in another form (`"5e0"` finds row 5) or be
 * rewritten by an app hook before Payload reads it. No covering frame refuses the write.
 */
const covering = (
  enforcer: Enforcer,
  req: PayloadRequest,
  resource: Resource,
  document: OperationTarget,
) =>
  frames.lookup(document, requestKeyOf(req)) ??
  refuse(enforcer, req, resource, "intent-missing", []);

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

type Files = () => boolean;

type PlanArgs = {
  resource: Resource;
  enforcer: Enforcer;
  operation: string;
  args: unknown;
  req: PayloadRequest;
  files: Files;
};

/**
 * Plans this operation's own frame, the innermost one covering its target. A frame that is
 * already planned belongs to another operation, so the write is refused rather than guessed.
 */
const plan = async ({ resource, enforcer, operation, args, req, files }: PlanArgs) => {
  const target = targetOf(resource, operation, args);
  if (target === null) {
    return;
  }
  settleTarget(args, target, req);
  const found = covering(enforcer, req, resource, target);
  const frame = found.innermost;
  if (frame.plan !== null) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  if (found.trusted) {
    frame.plan = { kind: "trusted" };
    return;
  }
  const subject = await enforcer.subject(req);
  if (subject.kind === "outsider" || subject.capabilities.kind === "all") {
    frame.plan = { kind: "exempt" };
    return;
  }
  const { capabilities, id: subjectId } = subject;
  const self = resource.slug === enforcer.options.userCollection;
  const held = new Set(
    [...resource.actions].filter((action) => can(capabilities, resource.id, action)),
  );
  const holds: Holds = (action) => held.has(action);
  const holdsOwn: Holds = (action) => action === "update" || held.has(action);
  const holdsFor = (documentId: unknown) =>
    self && isId(documentId) && sameId(documentId, subjectId) ? holdsOwn : holds;
  const source = isRecord(args) ? args : {};
  const view = viewOf(frame, source, frame.kind === "update" && files());
  const verdict = judge(
    resource,
    requestFacts(resource, view),
    // A restore's `args.id` is the version id, so its parent is unknown here; assume it may be
    // the member's own user and let beforeChange judge the real target.
    holdsFor(
      frame.kind === "update" ? source.id : frame.kind === "restore" ? subjectId : undefined,
    ),
  );
  // Payload deletes and writes an upload's files before beforeChange (G18), so such an update
  // must hold every possibility now.
  if (verdict.kind === "deny" || (view.files && verdict.kind !== "allow")) {
    refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
  }
  frame.plan = { kind: "enforce", view, holdsFor };
};

type Row = Readonly<Record<string, unknown>>;

type Enforced = { view: RequestView; holdsFor: (target: unknown) => Holds };

/**
 * The frames that must each allow a write to `document` once trust is lowered: the frames whose
 * id may name it, and every untrusted frame of its collection and kind under this request,
 * whatever id that frame was opened with. A member's id can name the document in another form
 * (`"7e0"` finds row 7) or be rewritten by an app hook, so only this keeps the member's own
 * frame judging its write when a laxer nested operation (a draft save, another user) runs inside
 * it. Each frame is judged as its own planned subject; an exempt one is an outsider's or a super
 * admin's. A frame with no plan, or planned as trusted before any untrusted frame covered it,
 * refuses.
 */
const judged = (
  enforcer: Enforcer,
  req: PayloadRequest,
  resource: Resource,
  document: OperationTarget,
): Enforced[] => {
  const found = covering(enforcer, req, resource, document);
  if (found.trusted) {
    return [];
  }
  const everyUntrusted =
    frames
      .lookup({ ...document, id: undefined }, requestKeyOf(req))
      ?.all.filter((frame) => !frame.trusted) ?? [];
  return [...new Set([...found.all, ...everyUntrusted])].flatMap(({ plan: current }) => {
    if (current === null || current.kind === "trusted") {
      refuse(enforcer, req, resource, "intent-missing", []);
    }
    return current.kind === "enforce" ? [current] : [];
  });
};

type CheckArgs = {
  resource: Resource;
  enforcer: Enforcer;
  document: OperationTarget;
  data: Row;
  req: PayloadRequest;
  readRow: () => Promise<null | Row>;
};

/** Every frame `judged` returns must allow the data about to be written; the row is read once. */
const check = async ({ resource, enforcer, document, data, req, readRow }: CheckArgs) => {
  let row: null | Row | undefined;
  for (const { view, holdsFor } of judged(enforcer, req, resource, document)) {
    const holds = holdsFor(document.id);
    const facts = settleAfter(resource, requestFacts(resource, view), data);
    let verdict = judge(resource, facts, holds);
    if (verdict.kind === "depends") {
      // oxlint-disable-next-line no-await-in-loop -- one read, reused by every later frame
      row ??= await readRow();
      if (row === null) {
        refuse(enforcer, req, resource, "target-missing", []);
      }
      verdict = judge(resource, settleBefore(resource, facts, row), holds);
    }
    if (verdict.kind !== "allow") {
      refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
    }
  }
};

/** The columns `settleBefore` reads, so a row read fetches no other field and joins no table. */
const stateSelect = (resource: Resource): SelectIncludeType => ({
  ...(resource.drafts && { [STATUS]: true }),
  ...(resource.trash && { deletedAt: true }),
});

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
  const restores = judged(enforcer, req, resource, {
    collection: resource.id,
    id: undefined,
    kind: "update",
  }).filter(({ view }) => view.kind === "restore");
  // A subject who holds what every stored version and row could require needs no read here;
  // Payload then answers a missing or unreadable version itself.
  const settled = restores.every(
    ({ view, holdsFor }) =>
      judge(resource, requestFacts(resource, view), holdsFor(undefined)).kind === "allow",
  );
  if (settled) {
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
  const row: unknown = await req.payload.db.findGlobal({
    slug: global.slug,
    req,
    select: stateSelect(resource),
  });
  for (const { view, holdsFor } of restores) {
    const facts = settleBefore(
      resource,
      settleAfter(resource, requestFacts(resource, view), {
        [STATUS]: view.draft ? "draft" : stored[STATUS],
      }),
      isRecord(row) ? row : {},
    );
    const verdict = judge(resource, facts, holdsFor(undefined));
    if (verdict.kind !== "allow") {
      refuse(enforcer, req, resource, "denied", verdict.kind === "deny" ? verdict.missing : []);
    }
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

const NOTHING: ReadonlySet<ActionId> = new Set();
const ONLY: Readonly<Record<WriteAccessArgs["key"], ReadonlySet<ActionId>>> = {
  create: new Set(["create"]),
  update: new Set(["update"]),
};

/** The floor uses the innermost covering frame's plan; outside an operation it is a probe. */
const requiredWriteActions = ({
  resource,
  key,
  data,
  id,
  req,
}: WriteAccessArgs): ReadonlySet<ActionId> => {
  // No hooks run for it, so no frame exists and the key itself is the whole answer.
  if (!resource.drafts && !resource.trash && !resource.versions) {
    return resource.actions.has(key) ? ONLY[key] : NOTHING;
  }
  const found = frames.lookup(
    { collection: resource.id, id: resource.kind === "collection" ? id : undefined, kind: key },
    requestKeyOf(req),
  );
  const current = found?.innermost.plan;
  const view = current?.kind === "enforce" ? { ...current.view, data } : probeView(key, data);
  return requiredActions(resource, requestFacts(resource, view));
};

const governs = (resource: Resource) => resource.drafts || resource.trash || resource.versions;

/**
 * An upload update writes or deletes stored files only for a new file or `uploadEdits` in the
 * query (`generateFileData.js:18-32,66,378`). A focal point in the body is compared with that same
 * body, so it never reuploads; without new files `deleteAssociatedFiles` deletes nothing.
 */
const touchesFiles = (req: PayloadRequest) =>
  req.file !== undefined || req.query.uploadEdits !== undefined;

const collectionHooks: LifecycleModule["collectionHooks"] = (resource, enforcer) => {
  if (!governs(resource)) {
    return {};
  }
  const select = stateSelect(resource);
  const trailing: CollectionBeforeOperationHook = async ({ args, collection, operation, req }) => {
    await plan({
      resource,
      enforcer,
      operation,
      args,
      req,
      files: () => Boolean(collection.upload) && touchesFiles(req),
    });
  };
  const beforeChange: CollectionBeforeChangeHook = async ({
    data,
    operation,
    originalDoc,
    req,
  }) => {
    const id = operation === "update" ? idOf(originalDoc) : null;
    await check({
      resource,
      enforcer,
      document: { collection: resource.id, id: id ?? undefined, kind: operation },
      data,
      req,
      // The main table only, trashed rows included.
      readRow: async () => {
        if (id === null) {
          return null;
        }
        const row: unknown = await req.payload.db.findOne({
          collection: resource.slug,
          req,
          select,
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
  const select = stateSelect(resource);
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
      document: { collection: resource.id, id: undefined, kind: "update" },
      data,
      req,
      // An unsaved global is `{}` on drizzle (findGlobal.js) and falsy elsewhere, which Payload
      // also treats as never saved (globals/operations/update.js `globalExists`).
      readRow: async () => {
        const row: unknown = await req.payload.db.findGlobal({ slug: resource.slug, req, select });
        return isRecord(row) ? row : {};
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
