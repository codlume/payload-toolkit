#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(fileURLToPath(import.meta.url), "../../../../..");
const appDir = path.join(repoRoot, "apps/payload-cms");
const artifactsDir = path.join(repoRoot, "artifacts/verify");
const latestFile = path.join(artifactsDir, "latest");
const s3 = {
  bucket: process.env.PAYLOAD_S3_BUCKET ?? "payload-blurhash",
  endpoint: process.env.PAYLOAD_S3_ENDPOINT ?? "http://127.0.0.1:4566",
};
const admin = { email: "verify@example.com", name: "Verify Admin", password: "verify-password" };
const modes = ["enabled-in-memory", "disabled-in-memory", "enabled-temporary-file"];

const fail = (message) => {
  console.error(`verify: ${message}`);
  process.exit(1);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const readOption = (args, name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });

const gitHead = () =>
  spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).stdout.trim();

const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) {
      newest = Math.max(newest, statSync(path.join(entry.parentPath, entry.name)).mtimeMs);
    }
  }
  return newest;
};

const stalePackages = () =>
  readdirSync(path.join(repoRoot, "packages")).filter((name) => {
    const packageDir = path.join(repoRoot, "packages", name);
    try {
      return newestMtime(path.join(packageDir, "dist")) < newestMtime(path.join(packageDir, "src"));
    } catch {
      return true;
    }
  });

const localstackReady = async () => {
  try {
    const response = await fetch(`${s3.endpoint}/${s3.bucket}`, { method: "HEAD" });
    return response.ok;
  } catch {
    return false;
  }
};

const loadRun = (runId) => {
  const id = runId ?? readFileSync(latestFile, "utf8").trim();
  return JSON.parse(readFileSync(path.join(artifactsDir, id, "run.json"), "utf8"));
};

const saveRun = (run) => {
  writeFileSync(
    path.join(artifactsDir, run.runId, "run.json"),
    `${JSON.stringify(run, null, 2)}\n`,
  );
};

const processAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const request = async (run, method, route, body, token) => {
  const init = {
    headers: token ? { authorization: `JWT ${token}` } : {},
    method,
    signal: AbortSignal.timeout(240_000),
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers["content-type"] = "application/json";
  }
  const response = await fetch(`http://127.0.0.1:${run.port}${route}`, init);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { json, status: response.status };
};

const login = async (run) => {
  const { json, status } = await request(run, "POST", "/api/users/login", {
    email: admin.email,
    password: admin.password,
  });
  if (status !== 200) fail(`login failed with ${status}: ${JSON.stringify(json)}`);
  return json.token;
};

const waitForAdmin = async (run, deadline) => {
  if (Date.now() > deadline) return false;
  if (!processAlive(run.pid)) return false;
  try {
    const { status } = await request(run, "GET", "/admin");
    if (status === 200) return true;
  } catch {}
  await sleep(2000);
  return waitForAdmin(run, deadline);
};

const seed = async (run) => {
  const registered = await request(run, "POST", "/api/users/first-register", admin);
  if (registered.status !== 200)
    fail(`first user: ${registered.status} ${JSON.stringify(registered.json)}`);
  const token = registered.json.token;
  const created = await request(
    run,
    "POST",
    "/api/pages",
    {
      _status: "published",
      layout: [1, 2, 3].map((n) => ({ blockType: "text", content: `Published block ${n}` })),
      slug: "verify",
      title: "Verify page",
    },
    token,
  );
  if (created.status !== 201) fail(`seed page: ${created.status} ${JSON.stringify(created.json)}`);
  const page = created.json.doc;
  const drafted = await request(
    run,
    "PATCH",
    `/api/pages/${page.id}?draft=true`,
    {
      layout: page.layout.map((block, index) =>
        Object.assign({}, block, { content: `Draft block ${index + 1}` }),
      ),
    },
    token,
  );
  if (drafted.status !== 200) fail(`seed draft: ${drafted.status} ${JSON.stringify(drafted.json)}`);
  return page.id;
};

const launch = async (args) => {
  const mode = readOption(args, "--mode") ?? "enabled-in-memory";
  if (!modes.includes(mode)) fail(`--mode must be one of ${modes.join(", ")}`);
  if (!(await localstackReady())) {
    fail(`S3 bucket ${s3.bucket} is not reachable at ${s3.endpoint}. Run \`pnpm services:up\`.`);
  }
  const stale = stalePackages();
  if (stale.length > 0) {
    console.log(`verify: building packages (${stale.join(", ")} missing or older than src)`);
    const build = spawnSync("pnpm", ["build:packages"], { cwd: repoRoot, stdio: "inherit" });
    if (build.status !== 0) fail("pnpm build:packages failed");
  }

  const runId = `verify-${new Date().toISOString().replaceAll(/[-:]/g, "").replace(/\..*/, "")}`;
  const runDir = path.join(artifactsDir, runId);
  const port = Number(readOption(args, "--port") ?? (await freePort()));
  const run = {
    distDir: `.next-e2e-${runId}`,
    evidenceDir: path.join(runDir, "evidence"),
    head: gitHead(),
    mode,
    origin: `http://localhost:${port}`,
    pid: 0,
    port,
    runId,
    s3Prefix: `tests/${runId}`,
    stateDir: path.join(runDir, "state"),
    testContext: args.includes("--test-context"),
    tsconfig: `tsconfig-e2e-${runId}.json`,
  };
  mkdirSync(run.stateDir, { recursive: true });
  mkdirSync(run.evidenceDir, { recursive: true });
  copyFileSync(path.join(appDir, "tsconfig.json"), path.join(appDir, run.tsconfig));
  writeFileSync(latestFile, `${runId}\n`);

  const log = openSync(path.join(runDir, "server.log"), "a");
  const server = spawn(
    "pnpm",
    ["exec", "next", "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: appDir,
      detached: true,
      env: {
        ...process.env,
        PAYLOAD_APP_MODE: mode,
        PAYLOAD_LIVE_PREVIEW_DEBUG: "true",
        PAYLOAD_LIVE_PREVIEW_TEST_CONTEXT: String(run.testContext),
        PAYLOAD_NEXT_DIST_DIRECTORY: run.distDir,
        PAYLOAD_NEXT_TSCONFIG_PATH: run.tsconfig,
        PAYLOAD_PUBLIC_SERVER_URL: run.origin,
        PAYLOAD_S3_PREFIX: run.s3Prefix,
        PAYLOAD_STATE_DIRECTORY: run.stateDir,
        PAYLOAD_TS_OUTPUT_PATH: path.join(run.stateDir, "payload-types.generated.ts"),
      },
      stdio: ["ignore", log, log],
    },
  );
  server.unref();
  run.pid = server.pid ?? 0;
  saveRun(run);
  console.log(
    `verify: started ${runId} (pid ${run.pid}) on ${run.origin}; compiling /admin takes up to 2 minutes`,
  );

  if (!(await waitForAdmin(run, Date.now() + 300_000))) {
    fail(`/admin never answered 200; see ${path.join(runDir, "server.log")}, then run \`stop\``);
  }
  if (args.includes("--no-seed")) {
    console.log(`verify: ready ${runId} (not seeded)\n  admin      ${run.origin}/admin`);
    return;
  }
  run.pageId = await seed(run);
  saveRun(run);
  console.log(
    [
      `verify: ready ${runId}`,
      `  admin      ${run.origin}/admin  (${admin.email} / ${admin.password})`,
      `  page       ${run.origin}/admin/collections/pages/${run.pageId}  (published + newer draft)`,
      `  public     ${run.origin}/pages/verify`,
      `  evidence   ${run.evidenceDir}`,
    ].join("\n"),
  );
};

const doctor = async (args) => {
  const run = loadRun(args[0]);
  const checks = [];
  const check = (ok, label) => checks.push({ label, ok });
  check(processAlive(run.pid), `server process ${run.pid} is running`);
  let adminStatus = 0;
  try {
    adminStatus = (await request(run, "GET", "/admin")).status;
  } catch {}
  check(adminStatus === 200, `${run.origin}/admin answers 200 (got ${adminStatus})`);
  if (adminStatus === 200 && run.pageId) {
    const token = await login(run);
    const me = await request(run, "GET", "/api/users/me", undefined, token);
    check(me.json?.user?.email === admin.email, `logged in as ${admin.email}`);
  }
  check(await localstackReady(), `S3 bucket ${s3.bucket} reachable at ${s3.endpoint}`);
  const head = gitHead();
  check(head === run.head, `checkout HEAD ${head} matches launch HEAD ${run.head}`);
  const stale = stalePackages();
  check(
    stale.length === 0,
    `package dist is newer than src${stale.length ? ` (stale: ${stale.join(", ")})` : ""}`,
  );
  for (const { label, ok } of checks) console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
  console.log(`run ${run.runId}: mode ${run.mode}${run.testContext ? ", test context" : ""}`);
  if (checks.some(({ ok }) => !ok)) process.exit(1);
};

const api = async (args) => {
  const [method, route, body] = args;
  if (!method || !route) fail("usage: api <METHOD> <path> [json-body]");
  const run = loadRun(undefined);
  const token = await login(run);
  const { json, status } = await request(
    run,
    method.toUpperCase(),
    route,
    body && JSON.parse(body),
    token,
  );
  console.log(JSON.stringify({ json, status }, null, 2));
  if (status >= 400) process.exit(1);
};

const deleteS3Prefix = async (prefix) => {
  const requireFromApp = createRequire(path.join(appDir, "package.json"));
  const { S3Client } = await import(
    pathToFileURL(requireFromApp.resolve("@aws-sdk/client-s3")).href
  );
  const { deleteOwnedS3Prefix } = await import(
    pathToFileURL(path.join(appDir, "tests/delete-owned-s3-prefix.mjs")).href
  );
  const client = new S3Client({
    credentials: { accessKeyId: "test", secretAccessKey: "test" },
    endpoint: s3.endpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });
  await deleteOwnedS3Prefix({ bucket: s3.bucket, client, prefix });
};

const stopRun = async (run) => {
  if (run.pid && processAlive(run.pid)) {
    process.kill(-run.pid, "SIGTERM");
    await sleep(3000);
    if (processAlive(run.pid)) process.kill(-run.pid, "SIGKILL");
  }
  rmSync(run.stateDir, { force: true, recursive: true });
  rmSync(path.join(appDir, run.distDir), { force: true, recursive: true });
  rmSync(path.join(appDir, run.tsconfig), { force: true });
  if (await localstackReady()) await deleteS3Prefix(run.s3Prefix);
  saveRun({ ...run, stoppedAt: new Date().toISOString() });
  console.log(`verify: stopped ${run.runId}; evidence kept in ${run.evidenceDir}`);
};

const stop = async (args) => {
  if (!args.includes("--all")) return stopRun(loadRun(args[0]));
  const runs = readdirSync(artifactsDir)
    .filter((id) => id.startsWith("verify-"))
    .map((id) => loadRun(id))
    .filter((run) => !run.stoppedAt);
  await Promise.all(runs.map((run) => stopRun(run)));
};

const commands = { api, doctor, launch, stop };
const [command, ...rest] = process.argv.slice(2);
const handler = command ? commands[command] : undefined;
if (!handler)
  fail(
    "usage: verify.mjs launch [--mode <mode>] [--test-context] [--port <n>] [--no-seed] | doctor [run] | api <METHOD> <path> [json] | stop [run|--all]",
  );
await handler(rest);
