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
  /** This operation's own `overrideAccess === true`; the scope ANDs it with every covering entry. */
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

const open =
  (resource: Resource) =>
  ({ args, operation, overrideAccess, req }: OpenArgs): undefined => {
    const kind = KINDS[operation];
    const target = targetOf(resource, operation, args);
    if (kind !== undefined && target !== null) {
      const source = isRecord(args) ? args : {};
      const trusted = overrideAccess === true;
      frames.open(target, requestKeyOf(req), trusted, {
        kind,
        trusted,
        bodyKeys: isRecord(source.data) ? Object.keys(source.data) : [],
        draft: Boolean(source.draft),
        plan: null,
      });
    }
  };

/**
 * The frames that may write `document` under this request, innermost first, and whether all of
 * them are trusted. `all` keeps only the entries whose id may name this document, so a trusted
 * write an app hook makes to another document is not judged as the member's. No covering frame
 * refuses the write.
 */
const covering = (
  enforcer: Enforcer,
  req: PayloadRequest,
  resource: Resource,
  document: OperationTarget,
) => {
  const found =
    frames.lookup(document, requestKeyOf(req)) ??
    refuse(enforcer, req, resource, "intent-missing", []);
  return {
    innermost: found.innermost,
    all: found.all,
    trusted: found.all.every((frame) => frame.trusted),
  };
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
  const found = covering(enforcer, req, resource, target);
  const frame = found.innermost;
  if (frame.plan !== null) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  if (found.trusted) {
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
    (documentId: unknown): Holds =>
    (action) =>
      can(capabilities, resource.id, action) ||
      (action === "update" && self && isId(documentId) && sameId(documentId, subjectId));
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
 * The untrusted frames that must each allow a write to `document`. A trusted frame adds no
 * permission; an exempt one is an outsider's or a super admin's. Lowered trust with nothing to
 * judge (the scope's depth cap) refuses.
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
  const plans = found.all.filter((frame) => !frame.trusted).map((frame) => frame.plan);
  if (plans.length === 0 || plans.includes(null)) {
    refuse(enforcer, req, resource, "intent-missing", []);
  }
  return plans.flatMap((current) => (current?.kind === "enforce" ? [current] : []));
};

type CheckArgs = {
  resource: Resource;
  enforcer: Enforcer;
  document: OperationTarget;
  data: Row;
  req: PayloadRequest;
  readRow: () => Promise<null | Row>;
};

/** Each covering untrusted frame judges the data about to be written; the row is read once. */
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
  if (restores.length === 0) {
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

/** The floor uses the innermost covering frame's plan; outside an operation it is a probe. */
const requiredWriteActions = ({
  resource,
  key,
  data,
  id,
  req,
}: WriteAccessArgs): ReadonlySet<ActionId> => {
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
      document: { collection: resource.id, id: undefined, kind: "update" },
      data,
      req,
      // An unsaved global is `{}` on drizzle (findGlobal.js) and falsy elsewhere, which Payload
      // also treats as never saved (globals/operations/update.js `globalExists`).
      readRow: async () => {
        const row: unknown = await req.payload.db.findGlobal({ slug: resource.slug, req });
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
