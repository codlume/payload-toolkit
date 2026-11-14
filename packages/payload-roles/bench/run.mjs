// Benchmarks the roles plugin's hot paths against the built dist, in one in-process Payload on
// in-memory SQLite. Run `pnpm build` first, on the Node version in the repository's `.node-version`.
//
//   node bench/run.mjs --preset small
//   node bench/run.mjs --preset large --roles-per-user 50 --out /tmp/large.json
//   node bench/run.mjs --preset small --enabled false     (control: same schema, enforcement off)
//   node bench/run.mjs --preset small --only '^users\.'   (regex over "op/variant/actor")
//   node bench/run.mjs --only '^find/rest/member' --cpu-profile /tmp/find.cpuprofile
//   node bench/profile-summary.mjs /tmp/find.cpuprofile   (where the timed rounds spent CPU)
//   node bench/compare.mjs before=a1.json,a2.json,a3.json after=b1.json,b2.json,b3.json
//
// Every cell is timed in interleaved rounds, one operation of each cell per round, so drift and
// machine noise fall on all cells alike. Queries are counted in a separate pass after timing, so
// the counters cost the timed region nothing: `sql` is every statement the adapter ran, and the
// plugin's share is the adapter calls made directly from the dist. The JSON summary goes to
// stdout and to `--out`; the table goes to stderr. Compare runs only when they alternated on one
// machine: a busy machine moves every median.
//
// Variants:
//   local-trusted  Local API with `overrideAccess: true`. No access functions, no guards.
//   local-warm     Local API as a user object reused across calls: the capability memo hits,
//                  except once every five seconds, when it expires.
//   local-cold     Local API as a new user object per call: the memo misses, as on every request.
//   rest           `handleEndpoints` with a JWT, so the request authenticates and the memo misses.
// Actors: `member` holds `rolesPerUser` roles; `super` is a super admin, whom role checks skip.
/* eslint-disable no-await-in-loop -- operations run one at a time, so each one's time and queries are its own */
import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import {
  buildConfig,
  createLocalReq,
  getAccessResults,
  getPayload,
  handleEndpoints,
} from "payload";

import { resolveCapabilities, rolesPlugin } from "@codlume/payload-roles";

// Payload connects to a Next dev server for HMR unless NODE_ENV is "test" or "production", and
// the SQLite adapter only pushes the schema outside "production".
process.env.NODE_ENV = "test";

const PRESETS = {
  small: { roles: 5, rolesPerUser: 5, users: 20, docs: 50, collections: 4, limit: 50, bulk: 10 },
  large: {
    roles: 50,
    rolesPerUser: 10,
    users: 200,
    docs: 1000,
    collections: 20,
    limit: 100,
    bulk: 50,
  },
};

const { values: flags } = parseArgs({
  options: {
    preset: { type: "string", default: "small" },
    roles: { type: "string" },
    "roles-per-user": { type: "string" },
    users: { type: "string" },
    docs: { type: "string" },
    collections: { type: "string" },
    limit: { type: "string" },
    bulk: { type: "string" },
    iterations: { type: "string", default: "200" },
    warmup: { type: "string", default: "30" },
    enabled: { type: "string", default: "true" },
    only: { type: "string" },
    out: { type: "string" },
    "cpu-profile": { type: "string" },
  },
});

const preset = PRESETS[flags.preset];
if (!preset) {
  throw new Error(
    `Unknown preset "${flags.preset}". Use one of ${Object.keys(PRESETS).join(", ")}.`,
  );
}

const integer = (value, fallback, name) => {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer; received ${value}.`);
  }
  return parsed;
};

const size = {
  roles: integer(flags.roles, preset.roles, "roles"),
  rolesPerUser: integer(flags["roles-per-user"], preset.rolesPerUser, "roles-per-user"),
  users: integer(flags.users, preset.users, "users"),
  docs: integer(flags.docs, preset.docs, "docs"),
  collections: integer(flags.collections, preset.collections, "collections"),
  limit: integer(flags.limit, preset.limit, "limit"),
  bulk: integer(flags.bulk, preset.bulk, "bulk"),
};
const iterations = integer(flags.iterations, 200, "iterations");
const warmup = integer(flags.warmup, 30, "warmup");
const enabled = flags.enabled !== "false";
const only = flags.only ? new RegExp(flags.only, "u") : null;

const FIXED_USERS = 4;
if (size.rolesPerUser > size.roles) {
  throw new Error("--roles-per-user cannot exceed --roles.");
}
if (size.limit > size.docs) {
  throw new Error("--limit cannot exceed --docs.");
}
if (size.bulk > size.users - FIXED_USERS) {
  throw new Error(`--bulk cannot exceed --users minus the ${FIXED_USERS} actors.`);
}

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`bench assertion failed: ${message}`);
  }
};

const PLUGIN_DIST = "/payload-roles/dist/";
const DB_METHODS = [
  "beginTransaction",
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
];

// Null while cells are timed, so the counters cost the timed region nothing.
let counting = null;
const fromPlugin = new AsyncLocalStorage();

const bump = (tally, key) => {
  tally[key] = (tally[key] ?? 0) + 1;
};

const logQuery = () => {
  if (counting) {
    counting.sql += 1;
    if (fromPlugin.getStore()) {
      counting.pluginSql += 1;
    }
  }
};

/** Wraps the adapter's methods and returns the function that puts the originals back. */
const installCounters = (db) => {
  const originals = new Map();
  for (const name of DB_METHODS) {
    const original = db[name];
    if (typeof original !== "function") {
      continue;
    }
    originals.set(name, original);
    db[name] = function counted(...args) {
      const label = [name, args[0]?.collection ?? args[0]?.slug].filter(Boolean).join(" ");
      // Frame 0 is this wrapper, frame 1 its direct caller.
      const caller = new Error("caller").stack?.split("\n")[2] ?? "";
      bump(counting.db, label);
      if (!caller.includes(PLUGIN_DIST)) {
        return Reflect.apply(original, this, args);
      }
      bump(counting.pluginDb, label);
      return fromPlugin.run(true, () => Reflect.apply(original, this, args));
    };
  }
  return () => {
    for (const [name, original] of originals) {
      db[name] = original;
    }
  };
};

const PASSWORD = "correct horse battery staple";
const managed = Array.from({ length: size.collections }, (_, index) => `c${index}`);
// Warnings and errors Payload logs at startup, then those logged while cells run. Only the
// second kind fails the run.
const startupWarnings = [];
const logProblems = [];
let measuring = false;

const config = await buildConfig({
  collections: [
    { slug: "users", auth: true, fields: [{ name: "name", type: "text" }] },
    ...managed.map((slug) => ({ slug, fields: [{ name: "title", type: "text" }] })),
  ],
  db: sqliteAdapter({ client: { url: ":memory:" }, logger: { logQuery } }),
  logger: {
    destination: {
      write: (line) => {
        if (/"level":(?:[4-9]\d)/u.test(line)) {
          (measuring ? logProblems : startupWarnings).push(line.trim());
        }
      },
    },
    options: { level: "info" },
  },
  plugins: [rolesPlugin({ collections: ["users", ...managed], enabled })],
  secret: "payload-roles-bench-secret",
  telemetry: false,
  typescript: { autoGenerate: false },
});

const key = `bench-${randomUUID()}`;
const payload = await getPayload({ config, key });

const seedStarted = performance.now();

const createUser = async (email, roles) => {
  const created = await payload.create({
    collection: "users",
    data: { email, name: email, password: PASSWORD, roles },
    depth: 0,
  });
  return created.id;
};

const superId = await createUser("super@bench.test", []);

// Every role grants the same cells on every managed collection, so a member's union costs
// `rolesPerUser * (collections + 1)` entries to parse and the member covers every other holder.
const permissions = {
  collections: {
    users: { actions: ["read", "update"] },
    ...Object.fromEntries(
      managed.map((slug) => [slug, { actions: ["read", "create", "update", "delete"] }]),
    ),
  },
};
const roleIds = [];
for (let index = 0; index < size.roles; index += 1) {
  const role = await payload.create({
    collection: "roles",
    data: { key: `role-${index}`, name: `Role ${index}`, permissions },
    depth: 0,
  });
  roleIds.push(role.id);
}
const heldRoles = roleIds.slice(0, size.rolesPerUser);

const memberId = await createUser("member@bench.test", heldRoles);
const targetId = await createUser("target@bench.test", heldRoles);
const strangerId = await createUser("stranger@bench.test", []);
const fillerIds = [];
for (let index = 0; index < size.users - FIXED_USERS; index += 1) {
  fillerIds.push(await createUser(`user-${index}@bench.test`, [roleIds[index % size.roles]]));
}
const bulkIds = fillerIds.slice(0, size.bulk);

const docIds = [];
for (let index = 0; index < size.docs; index += 1) {
  const doc = await payload.create({ collection: "c0", data: { title: `doc ${index}` }, depth: 0 });
  docIds.push(doc.id);
}

const seedMs = performance.now() - seedStarted;

const actorOf = async (id, email) => {
  const doc = await payload.findByID({ collection: "users", depth: 0, id });
  const login = await payload.login({ collection: "users", data: { email, password: PASSWORD } });
  assert(typeof login.token === "string", `login returned a token for ${email}`);
  return { user: { ...doc, collection: "users" }, token: login.token };
};

const actors = {
  member: await actorOf(memberId, "member@bench.test"),
  super: await actorOf(superId, "super@bench.test"),
};
const stranger = await actorOf(strangerId, "stranger@bench.test");

const rest = async (token, method, path, body) => {
  const response = await handleEndpoints({
    config,
    payloadInstanceCacheKey: key,
    request: new Request(`http://localhost/api${path}`, {
      ...(body !== undefined && { body: JSON.stringify(body) }),
      headers: {
        Authorization: `JWT ${token}`,
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      method,
    }),
  });
  const json = await response.json();
  return { json, status: response.status };
};

const okRest = async (token, method, path, body) => {
  const { json, status } = await rest(token, method, path, body);
  assert(status === 200, `${method} ${path} answered ${status}: ${JSON.stringify(json)}`);
  return json;
};

/** Local API options per variant. A cold call hands Payload a user object the memo never saw. */
const localAs = (actor) => ({
  "local-warm": () => ({ overrideAccess: false, user: actor.user }),
  "local-cold": () => ({ overrideAccess: false, user: { ...actor.user } }),
});

// With enforcement on, a user without roles must be refused; with it off, allowed. This proves
// the run measured the mode it claims.
const strangerRead = await payload
  .find({ collection: "c0", depth: 0, limit: 1, overrideAccess: false, user: stranger.user })
  .then(
    () => "allowed",
    (error) => (error?.status === 403 ? "forbidden" : `error: ${String(error)}`),
  );
assert(
  strangerRead === (enabled ? "forbidden" : "allowed"),
  `a user without roles reading c0 was ${strangerRead} with enabled=${enabled}`,
);

// Cells. Each `run(i)` performs one operation and checks its result.

const cells = [];
const cell = (op, variant, actor, run, share = 1) => {
  if (!only || only.test(`${op}/${variant}/${actor}`)) {
    cells.push({ op, variant, actor, run, share, samples: [] });
  }
};

const docAt = (i) => docIds[i % docIds.length];
// A roles update that always changes the stored set: all held roles, then all but the last.
const rolesAt = (i) => (i % 2 === 0 ? heldRoles.slice(0, -1) : heldRoles);
let unique = 0;

const TRUSTED = { "local-trusted": () => ({}) };

for (const [actorName, actor] of Object.entries(actors)) {
  const local = localAs(actor);
  const variants = actorName === "member" ? { ...TRUSTED, ...local } : local;

  for (const [variant, access] of Object.entries(variants)) {
    cell("find", variant, actorName, async () => {
      const result = await payload.find({
        collection: "c0",
        depth: 0,
        limit: size.limit,
        ...access(),
      });
      assert(result.docs.length === size.limit, `find returned ${result.docs.length} docs`);
    });
    cell("findByID", variant, actorName, async (i) => {
      const doc = await payload.findByID({
        collection: "c0",
        depth: 0,
        id: docAt(i),
        ...access(),
      });
      assert(doc.id === docAt(i), "findByID returned the document");
    });
    cell("update", variant, actorName, async (i) => {
      const title = `t${(unique += 1)}`;
      const doc = await payload.update({
        collection: "c0",
        data: { title },
        depth: 0,
        id: docAt(i),
        ...access(),
      });
      assert(doc.title === title, "update wrote the title");
    });
    cell("users.update-name", variant, actorName, async () => {
      const name = `n${(unique += 1)}`;
      const doc = await payload.update({
        collection: "users",
        data: { name },
        depth: 0,
        id: targetId,
        ...access(),
      });
      assert(doc.name === name, "users update wrote the name");
    });
    cell("users.update-roles", variant, actorName, async (i) => {
      const roles = rolesAt(i);
      const doc = await payload.update({
        collection: "users",
        data: { roles },
        depth: 0,
        id: targetId,
        ...access(),
      });
      assert(doc.roles.length === roles.length, "users update wrote the roles");
    });
    if (variant !== "local-cold") {
      const bulk = (label, dataAt) =>
        cell(
          `users.bulk-update-${label}[${size.bulk}]`,
          variant,
          actorName,
          async (i) => {
            const result = await payload.update({
              collection: "users",
              data: dataAt(i),
              depth: 0,
              where: { id: { in: bulkIds } },
              ...access(),
            });
            assert(
              result.docs.length === size.bulk && result.errors.length === 0,
              `bulk update wrote ${result.docs.length} users with ${result.errors.length} errors`,
            );
          },
          0.1,
        );
      bulk("name", () => ({ name: `b${(unique += 1)}` }));
      // Rounds run every tenth `i`, so alternate on the tens digit to change the roles each time.
      bulk("roles", (i) => ({ roles: rolesAt(Math.floor(i / 10)) }));
    }
  }

  cell("find", "rest", actorName, async () => {
    const json = await okRest(actor.token, "GET", `/c0?depth=0&limit=${size.limit}`);
    assert(json.docs.length === size.limit, `REST find returned ${json.docs.length} docs`);
  });
  cell("findByID", "rest", actorName, async (i) => {
    const json = await okRest(actor.token, "GET", `/c0/${docAt(i)}?depth=0`);
    assert(json.id === docAt(i), "REST findByID returned the document");
  });
  cell("update", "rest", actorName, async (i) => {
    const title = `t${(unique += 1)}`;
    const json = await okRest(actor.token, "PATCH", `/c0/${docAt(i)}?depth=0`, { title });
    assert(json.doc.title === title, "REST update wrote the title");
  });
  cell("users.update-name", "rest", actorName, async () => {
    const name = `n${(unique += 1)}`;
    const json = await okRest(actor.token, "PATCH", `/users/${targetId}?depth=0`, { name });
    assert(json.doc.name === name, "REST users update wrote the name");
  });
  cell("users.update-roles", "rest", actorName, async (i) => {
    const roles = rolesAt(i);
    const json = await okRest(actor.token, "PATCH", `/users/${targetId}?depth=0`, { roles });
    assert(json.doc.roles.length === roles.length, "REST users update wrote the roles");
  });

  const headers = new Headers({ Authorization: `JWT ${actor.token}` });
  cell("access", "rest", actorName, async () => {
    const json = await okRest(actor.token, "GET", "/access");
    assert(json.collections?.c0?.read === true, "REST access results allow reading c0");
  });
  cell("access", "payload.auth", actorName, async () => {
    const result = await payload.auth({ headers });
    assert(result.user?.id === actor.user.id, "payload.auth resolved the user");
    assert(result.permissions.collections?.c0?.read === true, "payload.auth allows reading c0");
  });
  for (const [variant, access] of Object.entries(local)) {
    cell("access", `results-${variant}`, actorName, async () => {
      const req = await createLocalReq({ user: access().user }, payload);
      const result = await getAccessResults({ req });
      assert(result.collections?.c0?.read === true, "access results allow reading c0");
    });
    cell("resolve", variant, actorName, async () => {
      const req = await createLocalReq({ user: access().user }, payload);
      const capabilities = await resolveCapabilities(req);
      assert(capabilities !== null, "the actor resolved to a member");
    });
  }
}

// A trusted create still runs the bootstrap hook. Password hashing dominates its time.
cell(
  "users.create",
  "local-trusted",
  "member",
  async () => {
    const email = `new-${(unique += 1)}@bench.test`;
    const created = await payload.create({
      collection: "users",
      data: { email, name: email, password: PASSWORD, roles: [] },
      depth: 0,
    });
    assert(created.email === email, "trusted create wrote the user");
  },
  0.1,
);

measuring = true;
// A profiled run slows the work down, so its timings are not a baseline.
const profiler = flags["cpu-profile"] ? new Session() : null;
if (profiler) {
  profiler.connect();
  await profiler.post("Profiler.enable");
  await profiler.post("Profiler.setSamplingInterval", { interval: 100 });
  await profiler.post("Profiler.start");
}
const timedStarted = performance.now();
for (let round = -warmup; round < iterations; round += 1) {
  for (const current of cells) {
    // A cell with `share` 0.1 runs in every tenth round.
    const every = Math.round(1 / current.share);
    if (Math.abs(round) % every !== 0) {
      continue;
    }
    const started = performance.now();
    await current.run(Math.abs(round));
    const elapsed = performance.now() - started;
    if (round >= 0) {
      current.samples.push(elapsed);
    }
  }
}
const timedMs = performance.now() - timedStarted;
if (profiler) {
  const { profile } = await profiler.post("Profiler.stop");
  writeFileSync(flags["cpu-profile"], JSON.stringify(profile));
  profiler.disconnect();
}

// Query counts, three counted runs per cell. The count most runs agree on is reported. Runs can
// disagree: the capability memo of a reused user object expires every five seconds, and the
// next call reloads the roles.

const COUNT_RUNS = 3;
const restore = installCounters(payload.db);
for (const current of cells) {
  const seen = new Map();
  for (let run = 0; run < COUNT_RUNS; run += 1) {
    counting = { sql: 0, pluginSql: 0, db: {}, pluginDb: {} };
    // Steps of 11 keep both alternations going: `rolesAt(i)` and `rolesAt(Math.floor(i / 10))`.
    await current.run(1000 + run * 11);
    const text = JSON.stringify(counting);
    seen.set(text, { count: (seen.get(text)?.count ?? 0) + 1, queries: counting });
    counting = null;
  }
  const [most] = [...seen.values()].toSorted((a, b) => b.count - a.count);
  current.queries = most.queries;
  current.queriesStable = seen.size === 1;
}
restore();

const round3 = (value) => Math.round(value * 1000) / 1000;

const stats = (samples) => {
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (quantile) =>
    sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)];
  return {
    n: sorted.length,
    medianMs: round3(at(0.5)),
    p95Ms: round3(at(0.95)),
    minMs: round3(sorted[0]),
    maxMs: round3(sorted.at(-1)),
    meanMs: round3(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
  };
};

const packageDirectory = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: packageDirectory, encoding: "utf8" }).trim();
const readJSON = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

const summary = {
  meta: {
    date: new Date().toISOString(),
    commit: git("rev-parse", "HEAD"),
    // True when `src` differs from the commit, so the numbers are not that commit's.
    srcDirty: git("status", "--porcelain", "--", "src").length > 0,
    distSha256: createHash("sha256")
      .update(readFileSync(new URL("../dist/index.mjs", import.meta.url)))
      .digest("hex")
      .slice(0, 16),
    node: process.version,
    payload: readJSON("../node_modules/payload/package.json").version,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    loadAverage: os.loadavg().map(round3),
    database: "sqlite :memory: (libsql), one connection, sequential operations",
    enforcement: enabled ? "on" : "off",
    profiled: profiler !== null,
    strangerRead,
    iterations,
    warmup,
    seedMs: Math.round(seedMs),
    timedMs: Math.round(timedMs),
    startupWarnings: startupWarnings.map((line) => JSON.parse(line).msg ?? JSON.parse(line).event),
    logProblems,
  },
  dataset: size,
  results: cells.map(({ op, variant, actor, samples, queries, queriesStable }) =>
    Object.assign({ op, variant, actor }, stats(samples), {
      sql: queries.sql,
      pluginSql: queries.pluginSql,
      db: queries.db,
      pluginDb: queries.pluginDb,
      queriesStable,
    }),
  ),
};

const pad = (value, width) => String(value).padEnd(width);
const padNumber = (value, width) => String(value).padStart(width);
const lines = [
  `payload-roles bench  commit ${summary.meta.commit.slice(0, 7)}${summary.meta.srcDirty ? "+dirty" : ""}  dist ${summary.meta.distSha256}  enforcement ${summary.meta.enforcement}`,
  `${summary.meta.cpu}, ${summary.meta.cores} cores, ${summary.meta.os}, Node ${summary.meta.node}, Payload ${summary.meta.payload}, load ${summary.meta.loadAverage.join(" ")}`,
  `dataset ${JSON.stringify(size)}  iterations ${iterations}  warmup ${warmup}`,
  "",
  `${pad("op", 30)}${pad("variant", 20)}${pad("actor", 8)}${padNumber("median", 9)}${padNumber("p95", 9)}${padNumber("sql", 6)}${padNumber("plugin", 8)}  plugin db calls`,
  ...summary.results.map(
    (row) =>
      `${pad(row.op, 30)}${pad(row.variant, 20)}${pad(row.actor, 8)}${padNumber(row.medianMs.toFixed(3), 9)}${padNumber(row.p95Ms.toFixed(3), 9)}${padNumber(row.sql, 6)}${padNumber(row.pluginSql, 8)}  ${
        Object.entries(row.pluginDb)
          .map(([label, count]) => `${label} x${count}`)
          .join(", ") || "-"
      }${row.queriesStable ? "" : "  (count varies)"}`,
  ),
];
if (logProblems.length > 0) {
  lines.push(
    "",
    `${logProblems.length} warn/error log lines while measuring:`,
    ...logProblems.slice(0, 5),
  );
}
console.error(lines.join("\n"));

const json = `${JSON.stringify(summary, null, 2)}\n`;
if (flags.out) {
  writeFileSync(flags.out, json);
}
process.stdout.write(json);

await payload.destroy();
process.exit(logProblems.length > 0 ? 1 : 0);
