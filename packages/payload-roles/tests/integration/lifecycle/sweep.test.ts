// Opt-in: skipped unless LIFECYCLE_SWEEP_SEQUENCES is set. Build the package first, then run
//   LIFECYCLE_SWEEP_SEQUENCES=500 LIFECYCLE_SWEEP_SEED=1 vitest run tests/integration/lifecycle/sweep.test.ts
// A violation prints the line that replays it alone.
import {
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  createLocalReq,
  type Payload,
  restoreVersionOperation,
  restoreVersionOperationGlobal,
} from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor as User, fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const SEQUENCES = Number(process.env.LIFECYCLE_SWEEP_SEQUENCES ?? 0);
const SEED = Number(process.env.LIFECYCLE_SWEEP_SEED ?? 1);
const FROM = Number(process.env.LIFECYCLE_SWEEP_FROM ?? 0);

const PAGE_ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "trash",
  "publish",
  "unpublish",
  "readVersions",
] as const;
const SETTINGS_ACTIONS = ["read", "update", "publish", "unpublish", "readVersions"] as const;
type Action = (typeof PAGE_ACTIONS)[number];

type Row = { published: boolean; trashed: boolean };
type Page = { main: Row; versions: Row[] } | null;
type Settings = { main: Row | null; versions: Row[]; total: number };
type Model = { page: Page; settings: Settings };

type Grants = { pages: Action[]; settings: Action[] };
type Actor = { kind: "member"; grants: Grants } | { kind: "superAdmin" } | { kind: "trusted" };

type PageData = { title?: string; _status?: "draft" | "published"; deletedAt?: null | string };
type Via = "alias" | "bulk" | "id" | "spelled";
type Op =
  | { kind: "create"; data: PageData; draft: boolean }
  | { kind: "update"; data: PageData; draft: boolean; autosave: boolean; trash: boolean; via: Via }
  | { kind: "delete"; trash: boolean; via: Via }
  | { kind: "restore"; index: number; draft: boolean }
  | {
      kind: "updateGlobal";
      data: { siteName?: string; _status?: "draft" | "published" };
      draft: boolean;
    }
  | { kind: "restoreGlobal"; index: number; draft: boolean };
type Step = { actor: Actor; op: Op };

type Observed = "blocked" | "forbidden" | "notFound" | "ok" | `error ${string}`;
type Expected = { accept: readonly Observed[]; needs: readonly Action[]; next: Model };

const DATE = "2026-01-01T00:00:00.000Z";
const STATUS = "_status";
const NEVER: Row = { published: false, trashed: false };
const live = (row: Row) => row.published && !row.trashed;

type Write = "create" | "edit" | "lifecycleOnly" | "restore";

const BASE: Record<Write, readonly Action[]> = {
  create: ["create"],
  edit: ["update"],
  lifecycleOnly: [],
  restore: ["update", "readVersions"],
};

/**
 * The approved v1 transition table, written from its rows (C, U, T, R, G, V in the rule tests)
 * rather than from `src/lifecycle/rules.ts`. A write that writes the main row is judged on the move
 * from the stored row to the row it leaves; a draft save writes only a version.
 */
const needsFor = (write: Write, before: Row | null, after: Row, writesMain: boolean) => {
  const out = new Set<Action>(BASE[write]);
  if (!writesMain) {
    // U1, R3: a draft save needs update; V1, V3: a trashed snapshot also needs trash.
    out.add("update");
    if (after.trashed) {
      out.add("trash");
    }
    return out;
  }
  const from = before ?? NEVER;
  const trashMoves = from.trashed !== after.trashed;
  if (trashMoves) {
    // T1, T2, C5: moving into or out of the trash needs trash, never unpublish.
    out.add("trash");
  } else if (live(from) && !live(after)) {
    // U4, U5, U6, R2, G3, G5: taking a live row off needs unpublish.
    out.add("unpublish");
  }
  if (live(after)) {
    // C2, U2, U3, U8, T3, R1, G2, G4: leaving a live row needs publish, and update unless a create.
    out.add("publish");
    if (write !== "create") {
      out.add("update");
    }
  }
  if (write === "lifecycleOnly" && !trashMoves && live(from) === live(after)) {
    // U7: a status-only body that moves nothing is a plain update.
    out.add("update");
  }
  return out;
};

const writeOf = (data: Record<string, unknown>): Write => {
  const keys = Object.keys(data);
  return keys.length > 0 && keys.every((key) => key === STATUS || key === "deletedAt")
    ? "lifecycleOnly"
    : "edit";
};

const fill = (data: PageData, source: Row, savingDraft: boolean): Row => ({
  published: savingDraft
    ? false
    : (data[STATUS] ?? (source.published ? "published" : "draft")) === "published",
  trashed: data.deletedAt === undefined ? source.trashed : data.deletedAt !== null,
});

const holds = (actor: Actor, scope: keyof Grants, needs: ReadonlySet<Action>) =>
  actor.kind !== "member" || [...needs].every((action) => actor.grants[scope].includes(action));

const UNREACHABLE = ["notFound", "forbidden"] as const;

const expected = (model: Model, { actor, op }: Step): Expected => {
  const unreachable = (accept: readonly Observed[] = UNREACHABLE): Expected => ({
    accept: actor.kind === "member" ? accept : accept.filter((outcome) => outcome !== "forbidden"),
    needs: [],
    next: model,
  });
  const judged = (scope: keyof Grants, needs: Set<Action>, next: Model): Expected => {
    const allowed = holds(actor, scope, needs);
    return {
      accept: [allowed ? "ok" : "forbidden"],
      needs: [...needs],
      next: allowed ? next : model,
    };
  };
  const { page, settings } = model;
  switch (op.kind) {
    case "create": {
      const after = fill(op.data, NEVER, op.draft);
      return judged("pages", needsFor("create", null, after, true), {
        ...model,
        page: { main: after, versions: [after] },
      });
    }
    case "update": {
      if (page === null) {
        return unreachable();
      }
      const visible = (row: Row | undefined) => (row && (op.trash || !row.trashed) ? row : null);
      const latest = page.versions.at(-1);
      const trashAttempt = op.data.deletedAt !== undefined && op.data.deletedAt !== null;
      // Payload's bulk update reads latest versions for a draft save or a trash attempt and main
      // rows otherwise; by id it reads the latest version, falling back to the main row.
      const source =
        op.via === "bulk"
          ? op.draft || trashAttempt
            ? visible(latest)
            : visible(page.main)
          : (visible(latest) ?? visible(page.main));
      if (source === null) {
        return unreachable();
      }
      const savingDraft = op.draft && op.data[STATUS] !== "published";
      const after = fill(op.data, source, savingDraft);
      const needs = needsFor(writeOf(op.data), page.main, after, !savingDraft);
      if (trashAttempt) {
        // Payload runs delete access on any body with a deletedAt date, and core answers it with
        // trash (src/access.ts), whatever the stored row.
        needs.add("trash");
      }
      return judged("pages", needs, {
        ...model,
        // Without `versions.drafts.autosave` Payload stores an autosave as a plain draft version.
        page: { main: savingDraft ? page.main : after, versions: [...page.versions, after] },
      });
    }
    case "delete":
      if (page === null || (page.main.trashed && !op.trash)) {
        return unreachable();
      }
      return judged("pages", new Set(["delete"]), { ...model, page: null });
    case "restore": {
      const snapshot = page?.versions[op.index];
      if (page === null || snapshot === undefined) {
        return unreachable();
      }
      if (page.main.trashed) {
        return unreachable(["blocked", "forbidden"]);
      }
      const after = { published: !op.draft && snapshot.published, trashed: snapshot.trashed };
      return judged("pages", needsFor("restore", page.main, after, !op.draft), {
        ...model,
        page: { main: op.draft ? page.main : after, versions: [...page.versions, after] },
      });
    }
    case "updateGlobal": {
      const source = settings.versions.at(-1) ?? settings.main ?? NEVER;
      const savingDraft = op.draft && op.data[STATUS] !== "published";
      const after = fill(op.data, source, savingDraft);
      return judged("settings", needsFor(writeOf(op.data), settings.main, after, !savingDraft), {
        ...model,
        settings: {
          main: savingDraft ? settings.main : after,
          total: settings.total + 1,
          versions: [...settings.versions, after],
        },
      });
    }
    case "restoreGlobal": {
      const snapshot = settings.versions[op.index];
      if (snapshot === undefined) {
        return unreachable();
      }
      // G4: a global restore always writes the main row.
      const after = { published: !op.draft && snapshot.published, trashed: false };
      return judged("settings", needsFor("restore", settings.main, after, true), {
        ...model,
        settings: {
          main: after,
          total: settings.total + 1,
          versions: [...settings.versions, after],
        },
      });
    }
    default: {
      const exhaustive: never = op;
      return exhaustive;
    }
  }
};

const required = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) {
    throw new Error(`${what} is missing`);
  }
  return value;
};

const prng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Random = ReturnType<typeof prng>;

const chance = (random: Random, p: number) => random() < p;
const oneOf = <T>(random: Random, items: readonly T[]): T =>
  required(items[Math.floor(random() * items.length)], "a random item");

const grantsOf = (random: Random, actions: readonly Action[]) => {
  const picked = actions.filter(() => chance(random, 0.5));
  return picked.includes("publish") && !picked.includes("update")
    ? actions.filter((action) => action === "update" || picked.includes(action))
    : picked;
};

const castOf = (random: Random): Actor[] => [
  ...Array.from(
    { length: 3 },
    (): Actor => ({
      grants: {
        pages: grantsOf(random, PAGE_ACTIONS),
        settings: grantsOf(random, SETTINGS_ACTIONS),
      },
      kind: "member",
    }),
  ),
  { kind: "superAdmin" },
  { kind: "trusted" },
];

const pageData = (random: Random): PageData => ({
  ...(chance(random, 0.5) && { title: "edited" }),
  ...(chance(random, 0.6) && { _status: oneOf(random, ["draft", "published"] as const) }),
  ...(chance(random, 0.4) && { deletedAt: oneOf(random, [null, DATE]) }),
});

const opOf = (random: Random, model: Model): Op => {
  if (model.page === null && chance(random, 0.8)) {
    return {
      data: {
        title: "created",
        ...(chance(random, 0.7) && { _status: oneOf(random, ["draft", "published"] as const) }),
        ...(chance(random, 0.15) && { deletedAt: DATE }),
      },
      draft: chance(random, 0.2),
      kind: "create",
    };
  }
  if (model.page?.main.trashed && chance(random, 0.5)) {
    // Random walks rarely reach this shape on their own: a draft save clears deletedAt on the
    // latest version only, then a live write reaches the trashed main row through that version.
    const viaLatest = !model.page.versions.at(-1)?.trashed;
    return {
      autosave: false,
      data: viaLatest ? pageData(random) : { deletedAt: null },
      draft: !viaLatest,
      kind: "update",
      trash: !viaLatest,
      via: oneOf(random, ["id", "spelled", "alias"] as const),
    };
  }
  const roll = model.page === null ? 0.75 + random() * 0.25 : random();
  const pageVersions = model.page?.versions.length ?? 0;
  if (roll < 0.55) {
    const via = oneOf(random, ["id", "id", "spelled", "alias", "bulk", "bulk"] as const);
    const draft = chance(random, 0.45);
    return {
      autosave: draft && via !== "bulk" && chance(random, 0.3),
      data: pageData(random),
      draft,
      kind: "update",
      trash: chance(random, 0.5),
      via,
    };
  }
  if (roll < 0.62) {
    return {
      kind: "delete",
      trash: chance(random, 0.5),
      via: oneOf(random, ["id", "spelled", "alias", "bulk"] as const),
    };
  }
  if (roll < 0.75 && pageVersions > 0) {
    return {
      draft: chance(random, 0.4),
      index: Math.floor(random() * pageVersions),
      kind: "restore",
    };
  }
  if (roll < 0.9 || model.settings.versions.length === 0) {
    return {
      data: {
        ...(chance(random, 0.6) && { siteName: "edited" }),
        ...(chance(random, 0.6) && { _status: oneOf(random, ["draft", "published"] as const) }),
      },
      draft: chance(random, 0.45),
      kind: "updateGlobal",
    };
  }
  return {
    draft: chance(random, 0.4),
    index: Math.floor(random() * model.settings.versions.length),
    kind: "restoreGlobal",
  };
};

const sequenceRandom = (index: number) => prng(SEED * 0x9e3779b1 + index * 0x85ebca6b);

let context: TestPayload;
let superAdmin: User;
let seats: { role: number | string; user: number | string }[] = [];

const resolveAlias: CollectionBeforeOperationHook = async ({ args, req }) => {
  const id: unknown = "id" in args ? args.id : undefined;
  if (typeof id === "string" && id.startsWith("slug:")) {
    const found = await req.payload.db.findOne<{ id: number | string }>({
      collection: "pages",
      req,
      where: { handle: { equals: id.slice("slug:".length) } },
    });
    return { ...args, id: found?.id ?? id };
  }
  return args;
};

/** The fixture collections, with an aliasable pages collection that keeps every version. */
const collections = (): CollectionConfig[] => {
  const all = fixtureCollections();
  const pages = required(
    all.find(({ slug }) => slug === "pages"),
    "the pages fixture",
  );
  pages.fields.push({ name: "handle", type: "text" });
  pages.hooks = { beforeOperation: [resolveAlias] };
  pages.versions = { drafts: true, maxPerDoc: 0 };
  return all;
};

beforeAll(async () => {
  if (SEQUENCES <= 0) {
    return;
  }
  context = await createTestPayload({
    collections: collections(),
    globals: [
      {
        fields: [{ name: "siteName", type: "text" }],
        slug: "settings",
        versions: { drafts: true, max: 0 },
      },
    ],
    name: "lifecycle-sweep",
  });
  const { payload } = context;
  superAdmin = await seedUser(payload, { email: "root@example.com", superAdmin: true });
  seats = await Promise.all(
    [0, 1, 2].map(async (seat) => {
      const role = await seedRole(payload, `sweep-${seat}`, {});
      const user = await seedUser(payload, { email: `sweep-${seat}@example.com`, roles: [role] });
      return { role, user: user.id };
    }),
  );
}, 120_000);

afterAll(async () => {
  if (SEQUENCES > 0) {
    await context.destroy();
  }
});

const usersOf = (payload: Payload, cast: readonly Actor[]) =>
  Promise.all(
    cast.map(async (actor, index) => {
      if (actor.kind === "trusted") {
        return undefined;
      }
      if (actor.kind === "superAdmin") {
        return superAdmin;
      }
      const seat = required(seats[index], `seat ${index}`);
      await payload.update({
        collection: "roles",
        data: {
          permissions: {
            collections: { pages: { actions: actor.grants.pages } },
            globals: { settings: { actions: actor.grants.settings } },
          },
        },
        id: seat.role,
      });
      return fresh(payload, seat.user);
    }),
  );

type StoredVersion = Row & { id: number | string; latest: boolean };
type Stored = {
  page: { main: Row; versions: StoredVersion[] } | null;
  settings: { main: Row | null; versions: StoredVersion[]; total: number };
};

const rowOf = (doc: Record<string, unknown>): Row => ({
  published: doc[STATUS] === "published",
  trashed: doc.deletedAt !== undefined && doc.deletedAt !== null,
});

const versionOf = (doc: {
  id: number | string;
  latest?: boolean;
  version: Record<string, unknown>;
}): StoredVersion => ({
  ...rowOf(doc.version),
  id: doc.id,
  latest: doc.latest === true,
});

const readStored = async (
  pageId: null | number | string,
  settingsTail: number,
): Promise<Stored> => {
  const { db } = context.payload;
  const main =
    pageId === null
      ? null
      : await db.findOne<Record<string, unknown> & { id: number | string }>({
          collection: "pages",
          where: { id: { equals: pageId } },
        });
  const pageVersions =
    pageId === null
      ? []
      : (
          await db.findVersions({
            collection: "pages",
            pagination: false,
            sort: "id",
            where: { parent: { equals: pageId } },
          })
        ).docs.map(versionOf);
  const globalRow: Record<string, unknown> = await db.findGlobal({ slug: "settings" });
  const globalVersions = await db.findGlobalVersions({
    global: "settings",
    limit: Math.max(settingsTail, 1),
    sort: "-id",
  });
  return {
    page: main ? { main: rowOf(main), versions: pageVersions } : null,
    settings: {
      main: Object.keys(globalRow).length > 0 && STATUS in globalRow ? rowOf(globalRow) : null,
      total: globalVersions.totalDocs,
      versions: globalVersions.docs.map(versionOf).slice(0, settingsTail).toReversed(),
    },
  };
};

const withLatest = (versions: readonly Row[]) =>
  versions.map(({ published, trashed }, index) => ({
    latest: index === versions.length - 1,
    published,
    trashed,
  }));

const comparable = (stored: Stored) => ({
  page: stored.page && {
    main: stored.page.main,
    versions: stored.page.versions.map(({ id: _, ...rest }) => rest),
  },
  settings: {
    main: stored.settings.main,
    total: stored.settings.total,
    versions: stored.settings.versions.map(({ id: _, ...rest }) => rest),
  },
});

const modelled = (model: Model) => ({
  page: model.page && { main: model.page.main, versions: withLatest(model.page.versions) },
  settings: { ...model.settings, versions: withLatest(model.settings.versions) },
});

const classify = (error: unknown): Observed => {
  if (!(error instanceof Error)) {
    return `error ${String(error)}`;
  }
  if (error.name === "Forbidden") {
    return "forbidden";
  }
  if (error.name === "NotFound") {
    return "notFound";
  }
  if (error.message.startsWith("Cannot restore a version of a trashed document")) {
    return "blocked";
  }
  return `error ${error.name}: ${error.message}`;
};

const bulkOutcome = ({
  docs,
  errors,
}: {
  docs: unknown[];
  errors: { message: string }[];
}): Observed =>
  errors.length > 0
    ? errors.every(({ message }) => message.includes("not allowed"))
      ? "forbidden"
      : `error ${JSON.stringify(errors)}`
    : docs.length === 0
      ? "notFound"
      : "ok";

type Target = { id: number | string; handle: string };

const run = async (
  op: Op,
  user: User | undefined,
  target: Target | null,
  stored: Stored,
  handle: string,
) => {
  const { payload } = context;
  const access = user ? { overrideAccess: false, user } : { overrideAccess: true };
  const req = () => createLocalReq(user ? { user } : {}, payload);
  const pageId = target?.id ?? -1;
  const idOf = (via: Via) =>
    via === "spelled" ? `${String(pageId)}e0` : via === "alias" ? `slug:${target?.handle}` : pageId;
  const byIds = { where: { id: { equals: pageId } } };
  const created: { target: Target | null } = { target: null };
  const observed = await (async (): Promise<Observed> => {
    try {
      switch (op.kind) {
        case "create": {
          const doc = await payload.create({
            collection: "pages",
            data: { ...op.data, handle },
            draft: op.draft,
            ...access,
          });
          created.target = { handle, id: doc.id };
          return "ok";
        }
        case "update": {
          const shared = { collection: "pages", data: op.data, draft: op.draft, trash: op.trash };
          if (op.via === "bulk") {
            return bulkOutcome(await payload.update({ ...shared, ...byIds, ...access }));
          }
          await payload.update({ ...shared, autosave: op.autosave, id: idOf(op.via), ...access });
          return "ok";
        }
        case "delete":
          if (op.via === "bulk") {
            return bulkOutcome(
              await payload.delete({ collection: "pages", trash: op.trash, ...byIds, ...access }),
            );
          }
          await payload.delete({
            collection: "pages",
            id: idOf(op.via),
            trash: op.trash,
            ...access,
          });
          return "ok";
        case "restore":
          await restoreVersionOperation({
            collection: required(payload.collections.pages, "the pages collection"),
            depth: 0,
            draft: op.draft,
            id: stored.page?.versions[op.index]?.id ?? -1,
            overrideAccess: access.overrideAccess,
            req: await req(),
          });
          return "ok";
        case "updateGlobal":
          await payload.updateGlobal({
            data: op.data,
            draft: op.draft,
            slug: "settings",
            ...access,
          });
          return "ok";
        case "restoreGlobal":
          await restoreVersionOperationGlobal({
            depth: 0,
            draft: op.draft,
            globalConfig: required(
              payload.globals.config.find(({ slug }) => slug === "settings"),
              "the settings global",
            ),
            id: stored.settings.versions[op.index]?.id ?? -1,
            overrideAccess: access.overrideAccess,
            req: await req(),
          });
          return "ok";
        default: {
          const exhaustive: never = op;
          return exhaustive;
        }
      }
    } catch (error) {
      return classify(error);
    }
  })();
  return { created: created.target, observed };
};

// The SQLite adapter clears `latest` only on versions with an older `updatedAt`, so two versions
// written in one millisecond both stay latest.
const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

type Violation = { index: number; steps: Step[]; detail: string };

const tally = new Map<string, number>();
const count = (key: string) => tally.set(key, (tally.get(key) ?? 0) + 1);

const sweepSequence = async (index: number): Promise<{ steps: number; violation?: Violation }> => {
  const random = sequenceRandom(index);
  const cast = castOf(random);
  const users = await usersOf(context.payload, cast);
  const length = 3 + Math.floor(random() * 10);
  // The global outlives sequences; three seeded writes give each one its own starting state.
  for (let n = 0; n < 3; n += 1) {
    // oxlint-disable-next-line no-await-in-loop -- versions in order
    await context.payload.updateGlobal({
      data: { [STATUS]: oneOf(random, ["draft", "published"] as const) },
      slug: "settings",
    });
    // oxlint-disable-next-line no-await-in-loop -- see tick
    await tick();
  }
  let target: Target | null = null;
  let stored = await readStored(null, 3);
  let model: Model = {
    page: null,
    settings: {
      main: stored.settings.main,
      total: stored.settings.total,
      versions: stored.settings.versions.map(({ published, trashed }) => ({ published, trashed })),
    },
  };
  const steps: Step[] = [];
  for (let n = 0; n < length; n += 1) {
    const seat = Math.floor(random() * cast.length);
    const step: Step = { actor: cast[seat] ?? { kind: "trusted" }, op: opOf(random, model) };
    steps.push(step);
    const want = expected(model, step);
    const handle = `s${SEED}-${index}-${n}`;
    // oxlint-disable-next-line no-await-in-loop -- each step runs on the state the last one left
    const { created, observed } = await run(step.op, users[seat], target, stored, handle);
    // oxlint-disable-next-line no-await-in-loop -- see tick
    await tick();
    if (observed === "ok") {
      if (step.op.kind === "create") {
        target = created;
      } else if (step.op.kind === "delete") {
        target = null;
      }
    }
    // oxlint-disable-next-line no-await-in-loop -- the step's own result
    stored = await readStored(target?.id ?? null, want.next.settings.versions.length);
    const { op } = step;
    count(`${op.kind}${"via" in op ? `/${op.via}` : ""}: ${observed}`);
    if (op.kind === "update" && model.page?.main.trashed && !model.page.versions.at(-1)?.trashed) {
      // The 23617c0 shape: a trashed main row reached through an untrashed latest version.
      count(`update of a trashed main row with an untrashed latest version: ${observed}`);
    }
    const nextModel = want.accept.includes(observed) && observed === "ok" ? want.next : model;
    const fail = (what: string) => ({
      steps: n + 1,
      violation: {
        detail: `step ${n}: ${what}\n  expected ${JSON.stringify(want.accept)} (needs ${JSON.stringify(want.needs)}), observed ${observed}\n  model before ${JSON.stringify(modelled(model))}\n  stored after  ${JSON.stringify(comparable(stored))}`,
        index,
        steps,
      },
    });
    if (!want.accept.includes(observed)) {
      return fail("outcome");
    }
    try {
      expect(comparable(stored)).toEqual(modelled(nextModel));
    } catch {
      return fail(`stored state differs from ${JSON.stringify(modelled(nextModel))}`);
    }
    model = nextModel;
  }
  return { steps: length };
};

test.skipIf(SEQUENCES <= 0)(
  `lifecycle invariant sweep (seed ${SEED}, sequences ${FROM}..${FROM + SEQUENCES - 1})`,
  async () => {
    const started = Date.now();
    const violations: Violation[] = [];
    let steps = 0;
    for (let index = FROM; index < FROM + SEQUENCES; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequences share the settings global
      const result = await sweepSequence(index);
      steps += result.steps;
      if (result.violation) {
        violations.push(result.violation);
      }
    }
    const report = violations
      .slice(0, 5)
      .map(
        ({ detail, index, steps: walk }) =>
          `LIFECYCLE_SWEEP_SEED=${SEED} LIFECYCLE_SWEEP_FROM=${index} LIFECYCLE_SWEEP_SEQUENCES=1\n  steps ${JSON.stringify(walk)}\n  ${detail}`,
      )
      .join("\n\n");
    console.log(
      `lifecycle sweep seed=${SEED} sequences=${SEQUENCES} from=${FROM} steps=${steps} violations=${violations.length} wall=${Date.now() - started}ms\n${JSON.stringify(Object.fromEntries([...tally].toSorted(([a], [b]) => a.localeCompare(b))), null, 1)}`,
    );
    expect(violations.length, `${violations.length} violating sequences\n\n${report}`).toBe(0);
  },
  Math.max(60_000, SEQUENCES * 20_000),
);
