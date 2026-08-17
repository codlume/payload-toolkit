import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, cp, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../run-command.mjs";
import { compatibilityLanes, dependencyVersions, pnpmVersion } from "./versions.mjs";

const repositoryDirectory = fileURLToPath(new URL("../../", import.meta.url));
const applicationSourceDirectory = path.join(repositoryDirectory, "apps/payload-cms");
const packageDirectory = path.join(repositoryDirectory, "packages/payload-blurhash");
const maximumPackOutputBytes = 10 * 1024 * 1024;

const requireEnvironment = (name) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required inside a compatibility lane.`);
  }

  return value;
};

const laneName = requireEnvironment("COMPAT_LANE");
const expectedNodeVersion = requireEnvironment("COMPAT_NODE_VERSION");
const expectedPayloadVersion = requireEnvironment("COMPAT_PAYLOAD_VERSION");
const lane = compatibilityLanes.find(({ name }) => name === laneName);

assert.ok(lane, `Unknown compatibility lane: ${laneName}`);
assert.equal(expectedNodeVersion, lane.node);
assert.equal(expectedPayloadVersion, lane.payload);
assert.equal(process.version, `v${lane.node}`);
assert.equal(dependencyVersions.payload, lane.payload);

const pack = (destination) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", destination],
      {
        cwd: packageDirectory,
        env: process.env,
        stdio: ["ignore", "pipe", "inherit"],
      },
    );
    const output = [];
    let outputBytes = 0;

    child.stdout.on("data", (chunk) => {
      outputBytes += chunk.length;

      if (outputBytes > maximumPackOutputBytes) {
        child.kill();
        reject(new Error("npm pack produced unexpectedly large JSON output."));
        return;
      }

      output.push(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== 0) {
        reject(new Error(`npm pack exited with ${code ?? signal}`));
        return;
      }

      const result = JSON.parse(Buffer.concat(output).toString("utf8"));
      assert.equal(result.length, 1);
      resolve(result[0].filename);
    });
  });

const ignoredApplicationDirectories = new Set([
  ".next",
  ".payload",
  "node_modules",
  "playwright-report",
  "test-results",
]);
const shouldCopyApplicationPath = (source) => {
  const relativePath = path.relative(applicationSourceDirectory, source);
  const [topLevelDirectory] = relativePath.split(path.sep);

  return !ignoredApplicationDirectories.has(topLevelDirectory);
};

const createConsumerPackageJSON = (tarballPath, consumerDirectory) => ({
  name: `payload-blurhash-${lane.name}-compatibility-consumer`,
  version: "0.0.0",
  private: true,
  type: "module",
  scripts: {
    build: "next build",
  },
  packageManager: `pnpm@${pnpmVersion}`,
  engines: {
    node: lane.node,
  },
  dependencies: {
    "@codlume/payload-blurhash": `file:${path.relative(consumerDirectory, tarballPath)}`,
    "@payloadcms/db-sqlite": dependencyVersions["@payloadcms/db-sqlite"],
    "@payloadcms/next": dependencyVersions["@payloadcms/next"],
    "@payloadcms/storage-s3": dependencyVersions["@payloadcms/storage-s3"],
    "@payloadcms/ui": dependencyVersions["@payloadcms/ui"],
    graphql: dependencyVersions.graphql,
    next: dependencyVersions.next,
    payload: lane.payload,
    react: dependencyVersions.react,
    "react-dom": dependencyVersions["react-dom"],
    sharp: dependencyVersions.sharp,
  },
  devDependencies: {
    "@aws-sdk/client-s3": dependencyVersions["@aws-sdk/client-s3"],
    "@aws-sdk/lib-storage": dependencyVersions["@aws-sdk/lib-storage"],
    "@playwright/test": dependencyVersions["@playwright/test"],
    "@types/node": dependencyVersions["@types/node"],
    "@types/react": dependencyVersions["@types/react"],
    "@types/react-dom": dependencyVersions["@types/react-dom"],
    blurhash: dependencyVersions.blurhash,
    esbuild: dependencyVersions.esbuild,
    typescript: dependencyVersions.typescript,
    vitest: dependencyVersions.vitest,
  },
  pnpm: {
    onlyBuiltDependencies: ["esbuild", "sharp"],
  },
});

let temporaryDirectory;

try {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), `payload-blurhash-${lane.name}-compat-`));
  const consumerDirectory = path.join(temporaryDirectory, "apps/payload-cms");
  await mkdir(path.dirname(consumerDirectory), { recursive: true });
  await cp(applicationSourceDirectory, consumerDirectory, {
    filter: shouldCopyApplicationPath,
    recursive: true,
  });
  await copyFile(
    path.join(repositoryDirectory, "tsconfig.base.json"),
    path.join(temporaryDirectory, "tsconfig.base.json"),
  );

  console.log(`[${lane.name}] Packing the real plugin artifact...`);
  const tarballFilename = await pack(temporaryDirectory);
  const tarballPath = path.join(temporaryDirectory, tarballFilename);
  await access(tarballPath);
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify(createConsumerPackageJSON(tarballPath, consumerDirectory), null, 2)}\n`,
  );

  console.log(`[${lane.name}] Generating an isolated consumer lockfile...`);
  await runCommand({
    arguments_: ["install", "--lockfile-only", "--strict-peer-dependencies"],
    command: "pnpm",
    cwd: consumerDirectory,
    env: process.env,
  });
  await access(path.join(consumerDirectory, "pnpm-lock.yaml"));
  await rm(path.join(consumerDirectory, "node_modules"), { force: true, recursive: true });

  console.log(`[${lane.name}] Proving a clean frozen-lockfile installation...`);
  await runCommand({
    arguments_: ["install", "--frozen-lockfile", "--strict-peer-dependencies"],
    command: "pnpm",
    cwd: consumerDirectory,
    env: process.env,
  });

  console.log(`[${lane.name}] Checking the installed tarball and pinned dependency graph...`);
  await runCommand({
    arguments_: ["--test", "tests/compat/installed-package.test.mjs"],
    command: process.execPath,
    cwd: consumerDirectory,
    env: process.env,
  });
  const lockfile = await readFile(path.join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lockfile, /workspace:/u);

  console.log(`[${lane.name}] Type-checking the shared application source...`);
  await runCommand({
    arguments_: ["exec", "tsc", "--noEmit"],
    command: "pnpm",
    cwd: consumerDirectory,
    env: process.env,
  });

  console.log(`[${lane.name}] Running configuration, lifecycle, decoder, and storage checks...`);
  await runCommand({
    arguments_: [
      "exec",
      "vitest",
      "run",
      "tests/compat/plugin-configuration.test.ts",
      "tests/integration",
      "--maxWorkers=1",
    ],
    command: "pnpm",
    cwd: consumerDirectory,
    env: process.env,
  });

  console.log(`[${lane.name}] Checking generated artifacts...`);
  await runCommand({
    arguments_: ["--test", "tests/build/generated-artifacts.test.mjs"],
    command: process.execPath,
    cwd: consumerDirectory,
    env: process.env,
  });

  console.log(`[${lane.name}] Building the shared application for production...`);
  await runCommand({
    arguments_: ["build"],
    command: "pnpm",
    cwd: consumerDirectory,
    env: process.env,
  });
  console.log(`[${lane.name}] Compatibility lane passed.`);
} finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
