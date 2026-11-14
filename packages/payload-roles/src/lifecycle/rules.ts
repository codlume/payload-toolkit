import { ACTION_IDS, type ActionId, type Resource } from "../contract.ts";

export type RowState = { readonly published: boolean; readonly trashed: boolean };

export type Write = "create" | "edit" | "lifecycleOnly" | "restore";

export type Before =
  | { readonly kind: "absent" }
  | { readonly kind: "known"; readonly row: RowState }
  | { readonly kind: "unknown"; readonly mayBeTrashed: boolean };

export type After = {
  readonly published: "either" | "unchanged" | boolean;
  readonly trashed: "unchanged" | boolean;
};

export type Facts = {
  readonly write: Write;
  readonly writesMain: boolean;
  readonly files: boolean;
  readonly before: Before;
  readonly after: After;
};

export type RequestView = {
  readonly kind: "create" | "restore" | "update";
  readonly duplicate: boolean;
  readonly bodyKeys: null | readonly string[];
  readonly files: boolean;
  readonly draft: boolean;
  readonly trash: boolean;
  readonly data: Readonly<Record<string, unknown>> | undefined;
};

export type Verdict =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly missing: readonly ActionId[] }
  | { readonly kind: "depends" };

export type RulesResource = Pick<Resource, "actions" | "drafts" | "kind" | "trash">;

type Move = { readonly before: RowState; readonly after: RowState };

type Transition =
  | { readonly write: Write; readonly main: Move }
  | {
      readonly write: Exclude<Write, "create">;
      readonly main: null;
      readonly trashes: boolean;
      readonly files: boolean;
    };

export const STATUS = "_status";

const ABSENT: RowState = { published: false, trashed: false };

const live = (row: RowState) => row.published && !row.trashed;

const BASE = {
  create: ["create"],
  edit: ["update"],
  lifecycleOnly: [],
  restore: ["readVersions", "update"],
} as const satisfies Record<Write, readonly ActionId[]>;

const inOrder = (keep: (action: ActionId) => boolean): ReadonlySet<ActionId> =>
  new Set(ACTION_IDS.filter((action) => keep(action)));

const transitionActions = (
  resource: RulesResource,
  transition: Transition,
): ReadonlySet<ActionId> => {
  const out = new Set<ActionId>(BASE[transition.write]);
  if (transition.main === null) {
    if (transition.write === "lifecycleOnly") {
      out.add("update");
    }
    if (transition.trashes) {
      out.add("trash");
    }
    // Payload deletes the old files on a draft save over a newer draft (utilities/update.js:88-98),
    // and those can be the live document's files.
    if (transition.files && resource.drafts) {
      out.add("publish");
      out.add("update");
    }
  } else {
    const { before, after } = transition.main;
    const trashChanged = before.trashed !== after.trashed;
    if (transition.write === "lifecycleOnly" && !trashChanged && live(before) === live(after)) {
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

const possibleTransitions = (resource: RulesResource, facts: Facts): readonly Transition[] => {
  if (!facts.writesMain && facts.write !== "create") {
    return [
      { write: facts.write, main: null, trashes: facts.after.trashed === true, files: facts.files },
    ];
  }
  const { published, trashed } = facts.after;
  return befores(resource, facts.before).flatMap((before) =>
    (published === "either"
      ? [false, true]
      : [published === "unchanged" ? before.published : published]
    ).map((after) => ({
      write: facts.write,
      main: {
        before,
        after: { published: after, trashed: trashed === "unchanged" ? before.trashed : trashed },
      },
    })),
  );
};

const beforeKey = (before: Before) =>
  before.kind === "known"
    ? `k${before.row.published}${before.row.trashed}`
    : before.kind === "unknown"
      ? `u${before.mayBeTrashed}`
      : "a";

/** Per resource, by facts. The facts of one resource take at most 1344 values. */
const memo = new WeakMap<RulesResource, Map<string, readonly ReadonlySet<ActionId>[]>>();

const actionSets = (resource: RulesResource, facts: Facts) => {
  const key = `${facts.write}|${facts.writesMain}|${facts.files}|${beforeKey(facts.before)}|${facts.after.published}|${facts.after.trashed}`;
  let byFacts = memo.get(resource);
  if (byFacts === undefined) {
    byFacts = new Map();
    memo.set(resource, byFacts);
  }
  let sets = byFacts.get(key);
  if (sets === undefined) {
    sets = possibleTransitions(resource, facts).map((transition) =>
      transitionActions(resource, transition),
    );
    byFacts.set(key, sets);
  }
  return sets;
};

export const requiredActions = (resource: RulesResource, facts: Facts): ReadonlySet<ActionId> => {
  const sets = actionSets(resource, facts);
  return inOrder((action) => sets.every((set) => set.has(action)));
};

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
        ? "lifecycleOnly"
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

export const requestFacts = (resource: RulesResource, view: RequestView): Facts => {
  const status = view.data?.[STATUS];
  return {
    write: writeOf(resource, view),
    writesMain: writesMainOf(resource, view, status),
    files: view.files,
    before:
      view.kind === "create"
        ? { kind: "absent" }
        : // Without `trash: true` Payload filters trashed main rows out of the request.
          { kind: "unknown", mayBeTrashed: view.kind === "update" && view.trash },
    after: {
      published: publishedAfter(resource, view, status),
      trashed: trashedAfter(resource, view, view.data?.deletedAt),
    },
  };
};

const isSet = (value: unknown) => value !== undefined && value !== null;

/**
 * A key absent from the data Payload writes leaves the stored value as it was. Field fills skip
 * it while `req.context.isRestoringVersion` is set (beforeValidate/promise.js:182), and restore
 * never clears that flag on a request GraphQL shares across mutations.
 */
const settled = <T extends boolean>(value: unknown, read: (value: unknown) => T): "unchanged" | T =>
  value === undefined ? "unchanged" : read(value);

/**
 * Pins the facts to the data `beforeChange` is about to write. Field `beforeValidate` has filled
 * every key by then (fields/hooks/beforeValidate/promise.js:182), so both values are definitive.
 * A drafts collection found the document through its latest version, whose `deletedAt` a draft
 * save can clear while the main row stays in the trash (getLatestCollectionVersion.js), so its
 * main row may be trashed even without `trash: true`.
 */
export const settleAfter = (
  resource: RulesResource,
  facts: Facts,
  data: Readonly<Record<string, unknown>>,
): Facts => ({
  ...facts,
  before:
    resource.drafts && facts.before.kind === "unknown"
      ? { kind: "unknown", mayBeTrashed: true }
      : facts.before,
  after: {
    published: !resource.drafts || settled(data[STATUS], (status) => status === "published"),
    trashed: resource.trash && settled(data.deletedAt, isSet),
  },
});

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
