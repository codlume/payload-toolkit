// Lifecycle enforcement benchmark for the `pages` fixture (drafts + trash). A plain Node script,
// not a vitest file, so `vitest run tests/integration` never picks it up.
//
// Run from packages/payload-roles after `pnpm build`:
//   node tests/integration/lifecycle/perf.bench.ts [--out results.json]
// Env: BENCH_ITERATIONS (200), BENCH_WARMUP (30), BENCH_COUNT_ITERATIONS (5),
//      BENCH_BASE_PAGES (1000), BENCH_BULK (20), BENCH_OPS (comma-separated op names; all),
//      BENCH_WIDE (1 gives every seeded page an array of five rows and a text list; off).
//
// Two passes over one Payload instance. The timing pass measures each operation with nothing
// wrapped. The counting pass then wraps every `payload.db` method and `enforcer.subject` and
// replays a few iterations, so the wrappers never skew the timings. Every iteration's result is
// checked against the stored row, untimed, and any mismatch or throw is counted as an error.
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { performance } from "node:perf_hooks";

import type { CollectionConfig, Payload } from "payload";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
} from "../../helpers/payload.ts";

type Id = number | string;
type Row = Record<string, unknown>;

const envInt = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
};

const ITERATIONS = envInt("BENCH_ITERATIONS", 200);
const WARMUP = envInt("BENCH_WARMUP", 30);
const COUNT_ITERATIONS = envInt("BENCH_COUNT_ITERATIONS", 5);
const BASE_PAGES = envInt("BENCH_BASE_PAGES", 1000);
const BULK = envInt("BENCH_BULK", 20);
const ONLY_OPS = process.env.BENCH_OPS?.split(",").filter(Boolean);
const WIDE = process.env.BENCH_WIDE === "1";
const outIndex = process.argv.indexOf("--out");
const OUT = outIndex === -1 ? undefined : process.argv[outIndex + 1];

const PLUGIN_SLUG = "@codlume/payload-roles";
const PAGES_ACTIONS = [
  "read",
  "create",
  "update",
  "delete",
  "trash",
  "publish",
  "unpublish",
  "readVersions",
];
const SETTINGS_ACTIONS = ["read", "update", "publish", "unpublish", "readVersions"];
/** No unpublish and no trash, so a write whose verdict turns on the stored row must read it. */
const PARTIAL_ACTIONS = ["read", "update", "publish"];

const packageDir = new URL("../../../", import.meta.url);
const distFile = new URL("dist/index.mjs", packageDir).pathname;
const distLines = readFileSync(distFile, "utf8").split("\n");

/** The fixture page has one text field. A real page also has rows in other tables. */
const widePages = (): CollectionConfig[] => {
  const collections = fixtureCollections();
  collections
    .find((collection) => collection.slug === "pages")
    ?.fields.push(
      {
        name: "sections",
        type: "array",
        fields: [
          { name: "heading", type: "text" },
          { name: "body", type: "textarea" },
        ],
      },
      { name: "tags", type: "text", hasMany: true },
    );
  return collections;
};

const context = await createTestPayload({
  name: "lifecycle-perf",
  roles: { ...defaultRolesOptions(), debug: false },
  ...(WIDE && { collections: widePages() }),
});
const { payload } = context;

const pageExtras: Row = WIDE
  ? {
      sections: Array.from({ length: 5 }, (_unused, index) => ({
        body: `body ${index} `.repeat(40),
        heading: `heading ${index}`,
      })),
      tags: ["alpha", "beta", "gamma"],
    }
  : {};

await seedUser(payload, { email: "bootstrap@example.com" });
const memberRole = await seedRole(payload, "pages-all", {
  collections: { pages: { actions: PAGES_ACTIONS } },
  globals: { settings: { actions: SETTINGS_ACTIONS } },
});
const partialRole = await seedRole(payload, "pages-partial", {
  collections: { pages: { actions: PARTIAL_ACTIONS } },
  globals: { settings: { actions: [...PARTIAL_ACTIONS, "readVersions"] } },
});
const member = await seedUser(payload, { email: "member@example.com", roles: [memberRole] });
const partial = await seedUser(payload, { email: "partial@example.com", roles: [partialRole] });
const admin = await seedUser(payload, { email: "admin@example.com", superAdmin: true });

type Side = {
  name: "member" | "memberPartial" | "memberWarm" | "superAdmin" | "trusted";
  trusted: boolean;
  /** A new object per call, as each HTTP request has, except `memberWarm`, which reuses one. */
  user: () => Actor;
  token?: string;
};

const SIDES: Side[] = [
  { name: "member", trusted: false, user: () => ({ ...member }) },
  { name: "memberWarm", trusted: false, user: () => member },
  { name: "superAdmin", trusted: false, user: () => ({ ...admin }) },
  { name: "trusted", trusted: true, user: () => ({ ...member }) },
];
/** Runs only in the operations that list it. */
const PARTIAL: Side = { name: "memberPartial", trusted: false, user: () => ({ ...partial }) };
const DEFAULT_SIDES = SIDES.map((side) => side.name);
const WITH_PARTIAL: Side["name"][] = [...DEFAULT_SIDES, "memberPartial"];
const REST_SIDES: Side["name"][] = ["member", "memberPartial", "superAdmin"];
const tokens: Partial<Record<Side["name"], string>> = {
  member: await login(payload, member.email),
  memberPartial: await login(payload, partial.email),
  superAdmin: await login(payload, admin.email),
};
const restAs = (side: Side) => rest(context, tokens[side.name] ?? null);

type Api = ReturnType<typeof as>;

/** `as` with access overridden: the same spread, so both sides run one code path. */
const trustedApi = (
  target: Payload,
  user: Actor,
): Pick<Api, "create" | "delete" | "restoreVersion" | "update" | "updateMany"> => ({
  create: (options) => target.create({ ...options, overrideAccess: true, user }),
  delete: (options) => target.delete({ ...options, overrideAccess: true, user }),
  restoreVersion: (options) => target.restoreVersion({ ...options, overrideAccess: true, user }),
  update: (options) => target.update({ ...options, overrideAccess: true, user }),
  updateMany: (options) => target.update({ ...options, overrideAccess: true, user }),
});

const apiOf = (side: Side, user: Actor) =>
  side.trusted ? trustedApi(payload, user) : as(payload, user);

/** Draft saves and bulk trash writes take flags `as` does not type; same spread, called direct. */
const access = (side: Side, user: Actor) => ({ overrideAccess: side.trusted, user });

const stored = (id: Id) =>
  payload.db.findOne<Row & { id: Id }>({ collection: "pages", where: { id: { equals: id } } });

const seedPage = async (title: string, status: "draft" | "published" = "published") => {
  const page = await payload.create({
    collection: "pages",
    data: { ...pageExtras, _status: status, title },
  });
  return page.id;
};

const trash = (id: Id) =>
  payload.update({ collection: "pages", data: { deletedAt: new Date().toISOString() }, id });

const storedSettings = async (): Promise<Row> => {
  const row: unknown = await payload.db.findGlobal({ slug: "settings" });
  return isRow(row) ? row : {};
};

const expectSettings = async (expected: Row) => {
  const row = await storedSettings();
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) {
      return `settings ${key}=${JSON.stringify(row[key])}, expected ${JSON.stringify(value)}`;
    }
  }
  return null;
};

const countPages = async () =>
  (await payload.count({ collection: "pages", trash: true })).totalDocs;

type Fixture = { ids: Id[] };
type Ctx = { title: string; id?: Id; versionId?: Id };

type Op = {
  name: string;
  sides?: Side["name"][];
  prepare: () => Promise<Fixture>;
  setup: (fixture: Fixture, title: string) => Promise<Ctx>;
  run: (side: Side, fixture: Fixture, ctx: Ctx) => Promise<unknown>;
  /** A failure message, or null when the write landed as expected. */
  check: (result: unknown, fixture: Fixture, ctx: Ctx) => Promise<null | string>;
};

const one = async (title: string, status: "draft" | "published" = "published") => ({
  ids: [await seedPage(title, status)],
});
const many = async (title: string, status: "draft" | "published" = "published") => {
  const ids: Id[] = [];
  for (let index = 0; index < BULK; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- fixture seeding, untimed
    ids.push(await seedPage(`${title} ${index}`, status));
  }
  return { ids };
};
const none = async (): Promise<Fixture> => ({ ids: [] });
const plain = async (_fixture: Fixture, title: string): Promise<Ctx> => ({ title });
const first = (fixture: Fixture) => {
  const [id] = fixture.ids;
  if (id === undefined) {
    throw new Error("fixture has no page");
  }
  return id;
};
const isRow = (value: unknown): value is Row => typeof value === "object" && value !== null;
const field = (value: unknown, key: string) => (isRow(value) ? value[key] : undefined);

const expectRow = async (id: unknown, expected: Row) => {
  if (typeof id !== "number" && typeof id !== "string") {
    return `no id in result`;
  }
  const row = await stored(id);
  if (row === null) {
    return `row ${id} missing`;
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual =
      key === "deletedAt" && value === "set" ? (row[key] ? "set" : row[key]) : row[key];
    if ((actual ?? null) !== value) {
      return `row ${id} ${key}=${JSON.stringify(actual)}, expected ${JSON.stringify(value)}`;
    }
  }
  return null;
};

const bulkOk = (result: unknown, size: number) => {
  const docs = field(result, "docs");
  const errors = field(result, "errors");
  if (!Array.isArray(docs) || !Array.isArray(errors)) {
    return "bulk result has no docs/errors";
  }
  return errors.length === 0 && docs.length === size
    ? null
    : `bulk wrote ${docs.length}/${size}, errors ${JSON.stringify(errors)}`;
};

const ALL_OPS: Op[] = [
  {
    name: "createDraft",
    prepare: async () => ({ ids: [] }),
    setup: plain,
    run: (side, _f, { title }) =>
      apiOf(side, side.user()).create({ collection: "pages", data: { title }, draft: true }),
    check: (result) => expectRow(field(result, "id"), { _status: "draft" }),
  },
  {
    name: "createPublished",
    prepare: async () => ({ ids: [] }),
    setup: plain,
    run: (side, _f, { title }) =>
      apiOf(side, side.user()).create({
        collection: "pages",
        data: { _status: "published", title },
      }),
    check: (result, _f, { title }) =>
      expectRow(field(result, "id"), { _status: "published", title }),
  },
  {
    name: "updateDraftSave",
    prepare: () => one("draft-save base"),
    setup: plain,
    run: (side, fixture, { title }) =>
      payload.update({
        collection: "pages",
        data: { title },
        draft: true,
        id: first(fixture),
        ...access(side, side.user()),
      }),
    check: async (result, fixture, { title }) =>
      field(result, "title") === title
        ? expectRow(first(fixture), { _status: "published", title: "draft-save base" })
        : "draft save returned another title",
  },
  {
    name: "updateLiveEdit",
    sides: WITH_PARTIAL,
    prepare: () => one("live base"),
    setup: plain,
    run: (side, fixture, { title }) =>
      apiOf(side, side.user()).update({
        collection: "pages",
        data: { _status: "published", title },
        id: first(fixture),
      }),
    check: (_r, fixture, { title }) => expectRow(first(fixture), { _status: "published", title }),
  },
  {
    name: "unpublish",
    prepare: () => one("unpublish base"),
    setup: async (fixture, title) => {
      await payload.update({
        collection: "pages",
        data: { _status: "published" },
        id: first(fixture),
      });
      return { title };
    },
    run: (side, fixture) =>
      apiOf(side, side.user()).update({
        collection: "pages",
        data: { _status: "draft" },
        id: first(fixture),
      }),
    check: (_r, fixture) => expectRow(first(fixture), { _status: "draft" }),
  },
  {
    name: "moveToTrash",
    prepare: () => one("trash base"),
    setup: async (fixture, title) => {
      await payload.update({
        collection: "pages",
        data: { deletedAt: null },
        id: first(fixture),
        trash: true,
      });
      return { title };
    },
    run: (side, fixture) =>
      apiOf(side, side.user()).update({
        collection: "pages",
        data: { deletedAt: new Date().toISOString() },
        id: first(fixture),
      }),
    check: (_r, fixture) => expectRow(first(fixture), { deletedAt: "set" }),
  },
  {
    name: "restoreFromTrash",
    prepare: () => one("restore base"),
    setup: async (fixture, title) => {
      await trash(first(fixture));
      return { title };
    },
    run: (side, fixture) =>
      payload.update({
        collection: "pages",
        data: { deletedAt: null },
        trash: true,
        where: { id: { in: [first(fixture)] } },
        ...access(side, side.user()),
      }),
    check: async (result, fixture) =>
      bulkOk(result, 1) ?? expectRow(first(fixture), { deletedAt: null }),
  },
  {
    name: "restoreVersion",
    prepare: () => one("version base"),
    setup: async (fixture, title) => {
      const id = first(fixture);
      await payload.update({ collection: "pages", data: { _status: "published", title }, id });
      await payload.update({
        collection: "pages",
        data: { title: `${title} later` },
        draft: true,
        id,
      });
      const { docs } = await payload.findVersions({
        collection: "pages",
        depth: 0,
        limit: 1,
        where: { parent: { equals: id }, "version.title": { equals: title } },
      });
      const versionId = docs[0]?.id;
      if (versionId === undefined) {
        throw new Error(`no version titled ${title}`);
      }
      return { title, versionId };
    },
    run: (side, _f, { versionId }) =>
      apiOf(side, side.user()).restoreVersion({ collection: "pages", id: String(versionId) }),
    check: (_r, fixture, { title }) => expectRow(first(fixture), { _status: "published", title }),
  },
  {
    name: "deletePermanent",
    prepare: async () => ({ ids: [] }),
    setup: async (_f, title) => {
      const id = await seedPage(title);
      await trash(id);
      return { id, title };
    },
    run: (side, _f, { id }) =>
      apiOf(side, side.user()).delete({ collection: "pages", id: id ?? "", trash: true }),
    check: async (_r, _f, { id }) =>
      id !== undefined && (await stored(id)) === null ? null : `row ${String(id)} still present`,
  },
  {
    name: `bulkUpdate${BULK}`,
    sides: WITH_PARTIAL,
    prepare: () => many("bulk base"),
    setup: plain,
    run: (side, fixture, { title }) =>
      apiOf(side, side.user()).updateMany({
        collection: "pages",
        data: { title },
        where: { id: { in: fixture.ids } },
      }),
    check: async (result) => bulkOk(result, BULK),
  },
  {
    name: "restLiveEdit",
    sides: ["member", "superAdmin"],
    prepare: () => one("rest base"),
    setup: plain,
    run: (side, fixture, { title }) =>
      restAs(side)("PATCH", `/pages/${first(fixture)}`, { _status: "published", title }),
    check: async (result, fixture, { title }) =>
      field(result, "status") === 200
        ? expectRow(first(fixture), { _status: "published", title })
        : `REST status ${String(field(result, "status"))}`,
  },
  // A title edit of a draft page without the draft flag keeps it a draft. Without `unpublish`
  // that is allowed only when the stored row is a draft too, so the lifecycle reads the row.
  {
    name: "editDraft",
    sides: WITH_PARTIAL,
    prepare: () => one("draft base", "draft"),
    setup: plain,
    run: (side, fixture, { title }) =>
      apiOf(side, side.user()).update({ collection: "pages", data: { title }, id: first(fixture) }),
    check: (_r, fixture, { title }) => expectRow(first(fixture), { _status: "draft", title }),
  },
  {
    name: `bulkEditDraft${BULK}`,
    sides: WITH_PARTIAL,
    prepare: () => many("bulk draft base", "draft"),
    setup: plain,
    run: (side, fixture, { title }) =>
      apiOf(side, side.user()).updateMany({
        collection: "pages",
        data: { title },
        where: { id: { in: fixture.ids } },
      }),
    check: async (result, fixture, { title }) =>
      bulkOk(result, BULK) ?? expectRow(fixture.ids.at(-1), { _status: "draft", title }),
  },
  // The admin asks for one document's permissions with the form state as the body.
  {
    name: "probeDocAccess",
    sides: REST_SIDES,
    prepare: () => one("probe base"),
    setup: plain,
    run: (side, fixture, { title }) =>
      restAs(side)("POST", `/pages/access/${first(fixture)}`, { _status: "published", title }),
    check: async (result) =>
      field(result, "status") === 200 && field(field(result, "json"), "update") === true
        ? null
        : `doc access ${JSON.stringify(result)}`,
  },
  // The admin's per-render permissions call: every entity's access functions, no document.
  {
    name: "probeAccess",
    sides: REST_SIDES,
    prepare: none,
    setup: plain,
    run: (side) => restAs(side)("GET", "/access"),
    check: async (result) =>
      field(result, "status") === 200 &&
      isRow(field(field(field(result, "json"), "collections"), "pages"))
        ? null
        : `access ${JSON.stringify(result)}`,
  },
  {
    name: "globalUpdate",
    sides: WITH_PARTIAL,
    prepare: none,
    setup: plain,
    run: (side, _f, { title }) =>
      payload.updateGlobal({
        data: { _status: "published", siteName: title },
        slug: "settings",
        ...access(side, side.user()),
      }),
    check: (_r, _f, { title }) => expectSettings({ _status: "published", siteName: title }),
  },
  // As `editDraft`, for a global: the stored row decides for a member without `unpublish`.
  {
    name: "globalEditDraft",
    sides: WITH_PARTIAL,
    prepare: none,
    setup: async (_f, title) => {
      await payload.updateGlobal({ data: { _status: "draft" }, slug: "settings" });
      return { title };
    },
    run: (side, _f, { title }) =>
      payload.updateGlobal({
        data: { siteName: title },
        slug: "settings",
        ...access(side, side.user()),
      }),
    check: (_r, _f, { title }) => expectSettings({ _status: "draft", siteName: title }),
  },
  {
    name: "globalRestore",
    sides: WITH_PARTIAL,
    prepare: none,
    setup: async (_f, title) => {
      for (const siteName of [title, `${title} later`]) {
        // oxlint-disable-next-line no-await-in-loop -- two versions in order, untimed
        await payload.updateGlobal({ data: { _status: "published", siteName }, slug: "settings" });
      }
      const { docs } = await payload.findGlobalVersions({
        depth: 0,
        limit: 1,
        slug: "settings",
        where: { "version.siteName": { equals: title } },
      });
      const versionId = docs[0]?.id;
      if (versionId === undefined) {
        throw new Error(`no settings version named ${title}`);
      }
      return { title, versionId };
    },
    run: (side, _f, { versionId }) =>
      payload.restoreGlobalVersion({
        id: String(versionId),
        slug: "settings",
        ...access(side, side.user()),
      }),
    check: (_r, _f, { title }) => expectSettings({ _status: "published", siteName: title }),
  },
];
const OPS = ALL_OPS.filter((op) => !ONLY_OPS || ONLY_OPS.includes(op.name));

type Counter = { active: boolean; calls: Map<string, number> };
const counter: Counter = { active: false, calls: new Map() };

const bump = (key: string) => counter.calls.set(key, (counter.calls.get(key) ?? 0) + 1);

/** The top-level declaration in dist/index.mjs that encloses `line`, or Payload's file. */
const callerOf = (stack: string | undefined) => {
  const frame = stack?.split("\n")[2] ?? "";
  const match = /\(?([^\s()]+):(\d+):\d+\)?$/u.exec(frame.trim());
  if (!match?.[1] || !match[2]) {
    return "unknown";
  }
  const [, file, line] = match;
  if (file.endsWith("/payload-roles/dist/index.mjs")) {
    for (let index = Number(line) - 1; index >= 0; index -= 1) {
      const name = /^(?:export )?(?:const|let|function|async function)\s+([\w$]+)/u.exec(
        distLines[index] ?? "",
      )?.[1];
      if (name) {
        return `roles:${name}`;
      }
    }
    return "roles:?";
  }
  const tail = file.split("node_modules/").at(-1) ?? file;
  return tail.replace(/^payload\/dist\//u, "payload:").replace(/^@payloadcms\//u, "");
};

const DB_METHODS = [
  "count",
  "countGlobalVersions",
  "countVersions",
  "create",
  "createGlobal",
  "createGlobalVersion",
  "createVersion",
  "deleteMany",
  "deleteOne",
  "deleteVersions",
  "find",
  "findDistinct",
  "findGlobal",
  "findGlobalVersions",
  "findOne",
  "findVersions",
  "queryDrafts",
  "updateGlobal",
  "updateGlobalVersion",
  "updateMany",
  "updateOne",
  "updateVersion",
  "upsert",
  "beginTransaction",
  "commitTransaction",
  "rollbackTransaction",
];

const targetOf = (args: unknown[]) => {
  const options = args[0];
  const name =
    field(options, "collection") ??
    field(options, "collectionSlug") ??
    field(options, "global") ??
    field(options, "globalSlug") ??
    field(options, "slug");
  return typeof name === "string" ? name : "-";
};

/** Wraps the instance's db methods and `enforcer.subject`; returns the undo. */
const instrument = () => {
  const restores: (() => void)[] = [];
  const wrap = (owner: object, name: string, key: (args: unknown[]) => string) => {
    const original: unknown = Reflect.get(owner, name);
    if (typeof original !== "function") {
      return;
    }
    Reflect.set(owner, name, function counted(this: unknown, ...args: unknown[]) {
      if (counter.active) {
        const caller = callerOf(new Error("count").stack);
        bump(key(args));
        bump(`${key(args)} <- ${caller}`);
      }
      return Reflect.apply(original, this, args);
    });
    restores.push(() => Reflect.set(owner, name, original));
  };
  for (const name of DB_METHODS) {
    wrap(payload.db, name, (args) => `db.${name} ${targetOf(args)}`);
  }
  const enforcer: unknown = payload.config.custom?.[PLUGIN_SLUG];
  if (!isRow(enforcer)) {
    throw new Error("roles enforcer not found on payload.config.custom");
  }
  wrap(enforcer, "subject", () => "subject");
  return () => {
    for (const undo of restores) {
      undo();
    }
  };
};

const sidesOf = (op: Op) =>
  [...SIDES, PARTIAL].filter((side) => (op.sides ?? DEFAULT_SIDES).includes(side.name));

const rotate = <T>(items: T[], by: number) => items.map((_, i) => items[(i + by) % items.length]!);

type Sample = { ms: number[]; errors: string[] };

const quantile = (sorted: number[], q: number) =>
  sorted.length === 0
    ? Number.NaN
    : sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
const round = (value: number) => Math.round(value * 1000) / 1000;

const summarize = ({ ms, errors }: Sample) => {
  const sorted = ms.toSorted((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / (sorted.length || 1);
  return {
    n: sorted.length,
    errors: errors.length,
    firstError: errors[0] ?? null,
    medianMs: round(quantile(sorted, 0.5)),
    p95Ms: round(quantile(sorted, 0.95)),
    meanMs: round(mean),
    minMs: round(sorted[0] ?? Number.NaN),
    maxMs: round(sorted.at(-1) ?? Number.NaN),
  };
};

/** One timed (or counted) call of `op` for `side`: untimed setup, timed run, untimed check. */
const once = async (op: Op, side: Side, fixture: Fixture, title: string, onRun: () => void) => {
  const ctx = await op.setup(fixture, title);
  context.logs.length = 0;
  onRun();
  const start = performance.now();
  let result: unknown;
  let failure: null | string = null;
  try {
    result = await op.run(side, fixture, ctx);
  } catch (error) {
    failure = `threw ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
  const ms = performance.now() - start;
  counter.active = false;
  failure ??= await op.check(result, fixture, ctx);
  return { failure, ms };
};

const timingPass = async () => {
  const results: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
  for (const op of OPS) {
    const sides = sidesOf(op);
    const fixtures = new Map<string, Fixture>();
    for (const side of sides) {
      // oxlint-disable-next-line no-await-in-loop -- sequential fixture seeding
      fixtures.set(side.name, await op.prepare());
    }
    const samples = new Map<string, Sample>(
      sides.map((side) => [side.name, { errors: [], ms: [] }]),
    );
    for (let iteration = 0; iteration < WARMUP + ITERATIONS; iteration += 1) {
      for (const side of rotate(sides, iteration)) {
        const title = `${op.name} ${side.name} ${iteration}`;
        // oxlint-disable-next-line no-await-in-loop -- one operation at a time is the measurement
        const { failure, ms } = await once(op, side, fixtures.get(side.name)!, title, () => {});
        if (iteration >= WARMUP) {
          const sample = samples.get(side.name)!;
          sample.ms.push(ms);
          if (failure) {
            sample.errors.push(failure);
          }
        }
      }
    }
    results[op.name] = Object.fromEntries(
      [...samples].map(([name, sample]) => [name, summarize(sample)]),
    );
    process.stderr.write(`timed ${op.name}\n`);
  }
  return results;
};

type Counts = Record<string, number | { min: number; max: number }>;

const countingPass = async () => {
  const undo = instrument();
  const results: Record<string, Record<string, { errors: number; counts: Counts }>> = {};
  try {
    for (const op of OPS) {
      const bySide: Record<string, { errors: number; counts: Counts }> = {};
      results[op.name] = bySide;
      for (const side of sidesOf(op)) {
        // oxlint-disable-next-line no-await-in-loop -- sequential fixture seeding
        const fixture = await op.prepare();
        const runs: Map<string, number>[] = [];
        let errors = 0;
        for (let iteration = 0; iteration < COUNT_ITERATIONS; iteration += 1) {
          counter.calls = new Map();
          const title = `count ${op.name} ${side.name} ${iteration}`;
          // oxlint-disable-next-line no-await-in-loop -- one operation at a time is the measurement
          const { failure } = await once(op, side, fixture, title, () => {
            counter.active = true;
          });
          errors += failure ? 1 : 0;
          runs.push(counter.calls);
        }
        const keys = [...new Set(runs.flatMap((run) => [...run.keys()]))].toSorted();
        const counts: Counts = {};
        for (const key of keys) {
          const values = runs.map((run) => run.get(key) ?? 0);
          const min = Math.min(...values);
          const max = Math.max(...values);
          counts[key] = min === max ? min : { min, max };
        }
        bySide[side.name] = { errors, counts };
      }
    }
  } finally {
    undo();
  }
  return results;
};

const gitHead = () => {
  try {
    return execSync("git rev-parse HEAD", { cwd: packageDir, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

const payloadVersion: unknown = JSON.parse(
  readFileSync(new URL("node_modules/payload/package.json", packageDir), "utf8"),
).version;

const startedAt = new Date();
const loadStart = os.loadavg();
const pagesAtStart = await (async () => {
  for (let index = 0; index < BASE_PAGES; index += 1) {
    // oxlint-disable-next-line no-await-in-loop -- dataset seeding
    await seedPage(`base ${index}`, index % 4 === 0 ? "draft" : "published");
  }
  return countPages();
})();
const wallStart = performance.now();
const timing = await timingPass();
const pagesAfterTiming = await countPages();
const counts = await countingPass();
const pagesAtEnd = await countPages();
const versionsAtEnd = (await payload.countVersions({ collection: "pages" })).totalDocs;

const report = {
  meta: {
    timestamp: startedAt.toISOString(),
    gitHead: gitHead(),
    node: process.version,
    payload: payloadVersion,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    totalMemGB: round(os.totalmem() / 2 ** 30),
    loadAvgStart: loadStart.map(round),
    loadAvgEnd: os.loadavg().map(round),
    wallSeconds: round((performance.now() - wallStart) / 1000),
    db: "sqlite :memory: (@payloadcms/db-sqlite)",
    config: {
      iterations: ITERATIONS,
      warmup: WARMUP,
      countIterations: COUNT_ITERATIONS,
      basePages: BASE_PAGES,
      bulk: BULK,
      wide: WIDE,
      rolesDebug: false,
    },
    sides: {
      member:
        "overrideAccess:false, role holds every pages and settings action, new user object per call",
      memberPartial:
        "as member, with read, update and publish only; runs in the operations that list it",
      memberWarm: "as member, one reused user object, so the capability memo is warm",
      superAdmin: "overrideAccess:false, superAdmin:true, new user object per call",
      trusted: "overrideAccess:true with the member as user: lifecycle plans trusted",
    },
  },
  dataset: { pagesAtStart, pagesAfterTiming, pagesAtEnd, pageVersionsAtEnd: versionsAtEnd },
  timing,
  counts,
};

await context.destroy();

const SIDE_NAMES = [...SIDES, PARTIAL].map((side) => side.name);
const pad = (text: string, width: number) => text.padEnd(width);
const timed = (name: string, op: Op) => {
  const stats = timing[op.name]?.[name];
  return stats
    ? `${stats.medianMs.toFixed(3)}/${stats.p95Ms.toFixed(3)}${stats.errors ? ` E${stats.errors}` : ""}`
    : "-";
};
const counted = (name: string, op: Op) => {
  const entry = counts[op.name]?.[name];
  return entry
    ? Object.entries(entry.counts)
        .filter(([key]) => !key.includes(" <- "))
        .map(
          ([key, value]) =>
            `${key}=${typeof value === "number" ? value : `${value.min}..${value.max}`}`,
        )
        .join(" ")
    : "-";
};
const lines = [
  `${pad("op", 18)}${SIDE_NAMES.map((name) => pad(`${name} med/p95 ms`, 24)).join("")}`,
];
for (const op of OPS) {
  lines.push(pad(op.name, 18) + SIDE_NAMES.map((name) => pad(timed(name, op), 24)).join(""));
}
lines.push("", "calls per op:");
for (const op of OPS) {
  lines.push(op.name);
  for (const name of SIDE_NAMES) {
    lines.push(`  ${pad(name, 11)} ${counted(name, op)}`);
  }
}
process.stdout.write(`${lines.join("\n")}\n\n${JSON.stringify(report)}\n`);
if (OUT) {
  writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`);
}
