// The lifecycle's whole policy as pure functions over plain data. No Payload import, no I/O.
//
// One rule, `transitionActions`, maps one fully known transition to the actions it needs. Each
// enforcement point describes what it knows as `Facts`, `possibleTransitions` expands every
// unknown into the transitions it allows, and the caller picks a policy over them:
//
//   access floor (sync, before any row is read)   requiredActions: what every possibility needs
//   pre-access check (trailing beforeOperation)   judge: deny only when no possibility is held,
//                                                 or, for an upload that may touch stored files,
//                                                 allow only when every possibility is held
//   beforeChange (data final, row on demand)      judge, then settleBefore + judge on "depends"
//
// A fact may overstate uncertainty, never understate it. A wider set of possibilities only
// shrinks the floor and only softens a "none held" denial, so a wrong-but-wide fact costs a
// main-row read or an early denial, never an unchecked transition.
import { ACTION_IDS, type ActionId, type Resource } from "../contract.ts";

/** The main row as the rules see it. On a resource without drafts, `published` is always true. */
export type RowState = { readonly published: boolean; readonly trashed: boolean };

/**
 * How the rules sort a write. `lifecycle` is an update whose client body held nothing but the
 * resource's lifecycle keys (`_status` with drafts, `deletedAt` with trash) and touches no stored
 * file: the stock Unpublish, Move to trash and Restore controls send exactly that.
 */
export type Write = "create" | "edit" | "lifecycle" | "restore";

/** What is known about the main row before the write. */
export type Before =
  | { readonly kind: "absent" }
  | { readonly kind: "known"; readonly row: RowState }
  | { readonly kind: "unknown"; readonly mayBeTrashed: boolean };

/**
 * What is known about the main row after the write. `"either"` while Payload may still fill
 * `_status` from a stored document the hook has not read; `"unchanged"` while the request leaves
 * `deletedAt` alone.
 */
export type After = {
  readonly published: "either" | boolean;
  readonly trashed: "unchanged" | boolean;
};

export type Facts = {
  readonly write: Write;
  /** False for a draft save, an autosave and a collection restore with `draft`. */
  readonly writesMain: boolean;
  readonly before: Before;
  readonly after: After;
};

/**
 * One write as the adapter parsed it from Payload's operation args. Values are decision-time,
 * read after every app `beforeOperation` hook, so they are what Payload acts on. `bodyKeys` is
 * copied before app hooks or field fills could add keys, and a restore's `draft` is the raw flag,
 * which Payload reads before any hook runs.
 */
export type RequestView = {
  readonly kind: "create" | "restore" | "update";
  readonly duplicate: boolean;
  /** `null` when no client body exists, as in an access probe. Never classified `lifecycle`. */
  readonly bodyKeys: null | readonly string[];
  /** An upload update that may write stored files before `beforeChange` (G18). */
  readonly files: boolean;
  readonly draft: boolean;
  readonly trash: boolean;
  readonly data: Readonly<Record<string, unknown>> | undefined;
};

export type Verdict =
  | { readonly kind: "allow" }
  /** `missing` is for the debug log only. */
  | { readonly kind: "deny"; readonly missing: readonly ActionId[] }
  /** Held for some possible main rows and not others: read the row, `settleBefore`, judge again. */
  | { readonly kind: "depends" };

/** The resource flags the rules read. `actions` filters every result to what applies. */
export type RulesResource = Pick<Resource, "actions" | "drafts" | "kind" | "trash">;

type Move = { readonly before: RowState; readonly after: RowState };

/**
 * A version-only write has no `main`: nothing live changes, so no row is ever needed. Its
 * snapshot still needs `trash` when it stores `deletedAt`, because a later publish writes it live.
 */
type Transition =
  | { readonly write: Write; readonly main: Move }
  | { readonly write: Exclude<Write, "create">; readonly main: null; readonly trashes: boolean };

/** Payload's draft status field (versions/baseFields.js). */
export const STATUS = "_status";

const ABSENT: RowState = { published: false, trashed: false };

const live = (row: RowState) => row.published && !row.trashed;

/** The action each write needs before lifecycle effects. `lifecycle` earns `update` back below. */
const BASE = {
  create: ["create"],
  edit: ["update"],
  lifecycle: [],
  restore: ["readVersions", "update"],
} as const satisfies Record<Write, readonly ActionId[]>;

const inOrder = (keep: (action: ActionId) => boolean): ReadonlySet<ActionId> =>
  new Set(ACTION_IDS.filter((action) => keep(action)));

/**
 * The rule. A `lifecycle` write that changes neither visibility nor trash state is a plain status
 * rewrite and needs `update`. Trashing never needs `unpublish` (Q4). Publishing an existing
 * document needs `update` too, the v1 role rule; a create is its own verb.
 */
const transitionActions = (
  resource: RulesResource,
  transition: Transition,
): ReadonlySet<ActionId> => {
  const out = new Set<ActionId>(BASE[transition.write]);
  if (transition.main === null) {
    if (transition.write === "lifecycle") {
      out.add("update");
    }
    if (transition.trashes) {
      out.add("trash");
    }
  } else {
    const { before, after } = transition.main;
    const trashChanged = before.trashed !== after.trashed;
    if (transition.write === "lifecycle" && !trashChanged && live(before) === live(after)) {
      out.add("update");
    }
    if (trashChanged) {
      out.add("trash");
    } else if (live(before) && !live(after)) {
      out.add("unpublish");
    }
    if (resource.drafts && live(after)) {
      out.add("publish");
      if (transition.write !== "create") {
        out.add("update");
      }
    }
  }
  return inOrder((action) => out.has(action) && resource.actions.has(action));
};

const cross = (publisheds: readonly boolean[], trasheds: readonly boolean[]): RowState[] =>
  publisheds.flatMap((published) => trasheds.map((trashed) => ({ published, trashed })));

const befores = (resource: RulesResource, before: Before): readonly RowState[] => {
  switch (before.kind) {
    case "absent":
      return [ABSENT];
    case "known":
      return [before.row];
    case "unknown":
      return cross(
        resource.drafts ? [false, true] : [true],
        resource.trash && before.mayBeTrashed ? [false, true] : [false],
      );
    default: {
      const exhaustive: never = before;
      return exhaustive;
    }
  }
};

/**
 * Every transition the facts allow. A version-only write is one transition, which is why draft
 * saves never read the main row. Before the field fill, a body that leaves `deletedAt` alone
 * counts as not trashing the snapshot: `settleAfter` pins the filled value in `beforeChange`,
 * and a wider guess here would refuse an update-only member's upload draft save pre-access.
 */
const possibleTransitions = (resource: RulesResource, facts: Facts): readonly Transition[] => {
  if (!facts.writesMain && facts.write !== "create") {
    return [{ write: facts.write, main: null, trashes: facts.after.trashed === true }];
  }
  const { published, trashed } = facts.after;
  const publisheds = published === "either" ? [false, true] : [published];
  return befores(resource, facts.before).flatMap((before) =>
    publisheds.map((after) => ({
      write: facts.write,
      main: {
        before,
        after: { published: after, trashed: trashed === "unchanged" ? before.trashed : trashed },
      },
    })),
  );
};

const actionSets = (resource: RulesResource, facts: Facts) =>
  possibleTransitions(resource, facts).map((transition) => transitionActions(resource, transition));

/**
 * The access floor: actions every possible transition needs. Exact when the facts are complete,
 * which makes it the oracle the rule table tests call. Never more than the precise answer, so it
 * can only under-deny, and the hooks enforce the difference.
 */
export const requiredActions = (resource: RulesResource, facts: Facts): ReadonlySet<ActionId> => {
  const sets = actionSets(resource, facts);
  return inOrder((action) => sets.every((set) => set.has(action)));
};

/**
 * `allow` when the editor holds every possibility, `deny` when it holds none, `depends` otherwise.
 * With complete facts there is one possibility, so the answer is never `depends`.
 */
export const judge = (
  resource: RulesResource,
  facts: Facts,
  holds: (action: ActionId) => boolean,
): Verdict => {
  const sets = actionSets(resource, facts);
  const held = sets.map((set) => [...set].every((action) => holds(action)));
  if (held.every((ok) => ok)) {
    return { kind: "allow" };
  }
  if (held.some((ok) => ok)) {
    return { kind: "depends" };
  }
  return {
    kind: "deny",
    missing: ACTION_IDS.filter((action) => !holds(action) && sets.some((set) => set.has(action))),
  };
};

const lifecycleKeys = (resource: RulesResource): readonly string[] => [
  ...(resource.drafts ? ["_status"] : []),
  ...(resource.trash ? ["deletedAt"] : []),
];

const writeOf = (resource: RulesResource, view: RequestView): Write => {
  switch (view.kind) {
    case "create":
      return "create";
    case "restore":
      return "restore";
    case "update": {
      const keys = lifecycleKeys(resource);
      return view.bodyKeys !== null &&
        view.bodyKeys.length > 0 &&
        !view.files &&
        view.bodyKeys.every((key) => keys.includes(key))
        ? "lifecycle"
        : "edit";
    }
    default: {
      const exhaustive: never = view.kind;
      return exhaustive;
    }
  }
};

/** Mirrors Payload's `isSavingDraft` (utilities/update.js:33-43); a global restore always writes the row (G4). */
const writesMainOf = (resource: RulesResource, view: RequestView, status: unknown) => {
  switch (view.kind) {
    case "create":
      return true;
    case "restore":
      return resource.kind === "global" || !view.draft;
    case "update":
      return !(view.draft && resource.drafts && status !== "published");
    default: {
      const exhaustive: never = view.kind;
      return exhaustive;
    }
  }
};

const publishedAfter = (
  resource: RulesResource,
  view: RequestView,
  status: unknown,
): After["published"] => {
  if (!resource.drafts) {
    return true;
  }
  if (view.kind === "create") {
    return view.draft ? false : view.duplicate ? "either" : status === "published";
  }
  if (view.kind === "restore" && view.draft) {
    return false;
  }
  return status === "published" ? true : status === "draft" ? false : "either";
};

const trashedAfter = (
  resource: RulesResource,
  view: RequestView,
  deletedAt: unknown,
): After["trashed"] => {
  if (!resource.trash) {
    return false;
  }
  if (deletedAt !== undefined) {
    return deletedAt !== null;
  }
  return view.kind === "create" ? false : "unchanged";
};

/** Facts from a parsed request, before Payload has filled `data` or the main row was read. */
export const requestFacts = (resource: RulesResource, view: RequestView): Facts => {
  const status = view.data?.[STATUS];
  return {
    write: writeOf(resource, view),
    writesMain: writesMainOf(resource, view, status),
    // Without `trash: true` Payload filters trashed rows out (updateByID.js:121, update.js:134).
    before:
      view.kind === "create"
        ? { kind: "absent" }
        : { kind: "unknown", mayBeTrashed: view.kind === "update" && view.trash },
    after: {
      published: publishedAfter(resource, view, status),
      trashed: trashedAfter(resource, view, view.data?.deletedAt),
    },
  };
};

const isSet = (value: unknown) => value !== undefined && value !== null;

/**
 * Pins `after` to the data `beforeChange` is about to write. Field `beforeValidate` has filled
 * every key by then (payload-ops 0.9), so both values are definitive.
 */
export const settleAfter = (
  resource: RulesResource,
  facts: Facts,
  data: Readonly<Record<string, unknown>>,
): Facts => ({
  ...facts,
  after: {
    published: !resource.drafts || data[STATUS] === "published",
    trashed: resource.trash && isSet(data.deletedAt),
  },
});

/**
 * Pins `before` to a stored main row from `payload.db.findOne` or `payload.db.findGlobal`. An
 * unsaved global (`{}`) reads as an unpublished, untrashed row.
 */
export const settleBefore = (
  resource: RulesResource,
  facts: Facts,
  row: Readonly<Record<string, unknown>>,
): Facts => ({
  ...facts,
  before: {
    kind: "known",
    row: {
      published: !resource.drafts || row[STATUS] === "published",
      trashed: resource.trash && isSet(row.deletedAt),
    },
  },
});
