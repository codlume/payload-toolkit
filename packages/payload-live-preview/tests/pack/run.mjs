import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL("./", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const readJSON = async (file) => JSON.parse(await readFile(file, "utf8"));
const manifest = await readJSON(path.join(packageDirectory, "package.json"));
const appManifest = await readJSON(
  new URL("../../../../apps/payload-cms/package.json", import.meta.url),
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
let temporaryDirectory;
let archive;

const run = async (command, args, cwd) => {
  try {
    return await exec(command, args, {
      cwd,
      env: {
        ...process.env,
        CI: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        NODE_PATH: "",
        NODE_TEST_CONTEXT: undefined,
      },
      maxBuffer: 50 * 1024 * 1024,
      timeout: 300_000,
    });
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${error.stdout}\n${error.stderr}`, {
      cause: error,
    });
  }
};

before(async () => {
  await run(pnpm, ["build"], packageDirectory);
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "payload-live-preview-pack-"));
  const packed = await run(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    packageDirectory,
  );
  const [result] = JSON.parse(packed.stdout);
  assert.equal(result.name, manifest.name);
  assert.equal(result.version, manifest.version);
  archive = result.filename;
  const files = result.files.map(({ path: file }) => file);
  for (const required of [
    "package.json",
    "README.md",
    "LICENSE",
    ...Object.values(manifest.exports)
      .flatMap(Object.values)
      .map((file) => file.replace(/^\.\//u, "")),
  ]) {
    assert.ok(files.includes(required), `tarball is missing ${required}`);
  }
  for (const file of files) {
    assert.match(
      file,
      /^(?:package\.json|README\.md|LICENSE|dist\/[\w-]+\.(?:mjs|d\.mts))$/u,
      `unexpected packed file: ${file}`,
    );
  }
});

after(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { force: true, recursive: true });
});

const install = async (name, dependencies = []) => {
  const directory = path.join(temporaryDirectory, name);
  await mkdir(directory);
  await cp(path.join(fixtures, name), directory, { recursive: true });
  await cp(path.join(fixtures, "assert-package.mjs"), path.join(directory, "assert-package.mjs"));
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify(
      {
        name: `live-preview-${name}-consumer`,
        private: true,
        type: "module",
        dependencies: {
          [manifest.name]: `file:../${archive}`,
          ...Object.fromEntries(
            dependencies.map((dependency) => [
              dependency,
              manifest.devDependencies[dependency] ?? appManifest.dependencies[dependency],
            ]),
          ),
        },
        devDependencies: { typescript: manifest.devDependencies.typescript },
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(directory, "pnpm-workspace.yaml"),
    "packages:\n  - .\n\nallowBuilds:\n  esbuild: true\n  sharp: true\n",
  );
  await writeFile(
    path.join(directory, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          exactOptionalPropertyTypes: true,
          jsx: "react-jsx",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          noEmit: true,
          skipLibCheck: name === "payload",
          strict: true,
          target: "ES2022",
          types: [],
        },
        include: ["contract.ts", "contract.tsx"],
      },
      null,
      2,
    ),
  );
  await run(pnpm, ["install", "--lockfile-only", "--strict-peer-dependencies"], directory);
  await run(pnpm, ["install", "--frozen-lockfile", "--strict-peer-dependencies"], directory);
  await run(pnpm, ["exec", "tsc", "--noEmit"], directory);
  return directory;
};

void test("core consumer imports and type-checks with no React, Payload or Admin installed", async () => {
  const directory = await install("core");
  const result = await run(process.execPath, ["--test", "assert.test.mjs"], directory);
  console.log(result.stdout);
});

void test("React consumer builds server and client routes without Payload or Admin", async () => {
  const directory = await install("react", [
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
    "@types/node",
    "next",
  ]);
  // Check declarations with NodeNext first, then build using Next's bundler resolution.
  const config = await readJSON(path.join(directory, "tsconfig.json"));
  Object.assign(config.compilerOptions, {
    module: "ESNext",
    moduleResolution: "Bundler",
    skipLibCheck: true,
  });
  config.include = ["**/*.ts", "**/*.tsx", ".next/types/**/*.ts"];
  await writeFile(path.join(directory, "tsconfig.json"), JSON.stringify(config, null, 2));
  await run(pnpm, ["exec", "next", "build"], directory);
  const result = await run(process.execPath, ["--test", "assert.test.mjs"], directory);
  console.log(result.stdout);
});

void test("Payload application resolves all entries and generates its Admin import map", async () => {
  const directory = await install("payload", [
    "payload",
    "@payloadcms/next",
    "@payloadcms/ui",
    "@payloadcms/db-sqlite",
    "graphql",
    "next",
    "react",
    "react-dom",
    "@types/react",
    "@types/react-dom",
  ]);
  await run(pnpm, ["exec", "payload", "generate:importmap"], directory);
  const server = await run(
    process.execPath,
    ["--test", "--test-force-exit", "assert-server.test.mjs"],
    directory,
  );
  console.log(server.stdout);
  const client = await run(
    process.execPath,
    ["--experimental-loader", "./ignore-css-loader.mjs", "--test", "assert-client.test.mjs"],
    directory,
  );
  console.log(client.stdout);
});
