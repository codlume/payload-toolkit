import assert from "node:assert/strict";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const name = "@codlume/payload-live-preview";
const directory = fileURLToPath(new URL("./", import.meta.url));
const packageDirectory = fileURLToPath(new URL("../", import.meta.resolve(`${name}/core`)));
const read = (file) => readFile(path.join(packageDirectory, file), "utf8");

export const assertAbsent = async (packages) => {
  const installed = await readdir(path.join(directory, "node_modules/.pnpm"));
  for (const dependency of packages) {
    assert.throws(() => import.meta.resolve(dependency), { code: "ERR_MODULE_NOT_FOUND" });
    assert.ok(
      !installed.some((entry) => entry.startsWith(`${dependency.replace("/", "+")}@`)),
      `${dependency} was installed transitively`,
    );
  }
};

export const assertPackage = async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.deepEqual(manifest.exports, {
    ".": { types: "./dist/index.d.mts", import: "./dist/index.mjs" },
    "./core": { types: "./dist/core.d.mts", import: "./dist/core.mjs" },
    "./react": { types: "./dist/react.d.mts", import: "./dist/react.mjs" },
    "./client": { types: "./dist/client.d.mts", import: "./dist/client.mjs" },
  });
  assert.equal(manifest.type, "module");
  assert.equal(manifest.sideEffects, false);
  assert.equal(manifest.engines.node, ">=22.12.0 <23 || >=24.0.0 <25");
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.peerDependencies, {
    payload: ">=3.88.0 <4",
    "@payloadcms/ui": ">=3.88.0 <4",
    react: "^19.0.1 || ^19.1.2 || ^19.2.1",
  });
  assert.deepEqual(manifest.peerDependenciesMeta, {
    payload: { optional: true },
    "@payloadcms/ui": { optional: true },
    react: { optional: true },
  });
  await Promise.all(
    Object.entries(manifest.exports).map(async ([entry, mapping]) => {
      assert.equal(
        fileURLToPath(import.meta.resolve(name + entry.slice(1))),
        path.join(packageDirectory, mapping.import),
      );
      await access(path.join(packageDirectory, mapping.types));
    }),
  );
  for (const privatePath of [
    "marker",
    "renderer",
    "preview-bridge",
    "dist/marker.mjs",
    "dist/renderer.d.mts",
    "src/core.ts",
    "package.json",
  ]) {
    assert.throws(() => import.meta.resolve(`${name}/${privatePath}`), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  }
  const installedPath = await realpath(packageDirectory);
  assert.ok(
    installedPath.startsWith(`${await realpath(directory)}${path.sep}`),
    "package must be installed inside the temporary consumer",
  );
  const lockfile = await readFile(path.join(directory, "pnpm-lock.yaml"), "utf8");
  assert.doesNotMatch(lockfile, /workspace:|link:/u);
  assert.match(lockfile, /file:.*\.tgz/u);
  assert.ok((await read("README.md")).length > 0);
  assert.match(await read("LICENSE"), /MIT License/u);
  assert.match(await read("dist/client.mjs"), /^["']use client["'];/u);
};

// Follow both runtime and declaration imports in the installed archive, including
// side-effect imports and import types that a `from`-only regex would miss.
export const assertFrontendGraph = async (entry) => {
  await Promise.all(
    ["mjs", "d.mts"].map(async (extension) => {
      const visited = new Set();
      const clientModules = [];
      const visit = async (file) => {
        if (visited.has(file)) return;
        visited.add(file);
        const source = await read(file);
        assert.doesNotMatch(source, /["']use server["']/u);
        if (file === `dist/${entry}.${extension}`) {
          assert.doesNotMatch(
            source,
            /^["']use client["'];/u,
            "frontend entry must remain server-callable",
          );
        }
        if (/^["']use client["'];/u.test(source)) clientModules.push(file);
        await Promise.all(
          ts
            .preProcessFile(source, true, true)
            .importedFiles.map(async ({ fileName: dependency }) => {
              if (dependency.startsWith(".")) {
                const target = path.posix.normalize(
                  path.posix.join(path.posix.dirname(file), dependency),
                );
                assert.ok(target.startsWith("dist/"), `import escapes dist: ${target}`);
                assert.doesNotMatch(
                  target,
                  /^dist\/(?:index|client)\./u,
                  "frontend imports the configuration or Admin entry",
                );
                await visit(extension === "d.mts" ? target.replace(/\.mjs$/u, ".d.mts") : target);
              } else {
                assert.ok(
                  entry === "react" && ["react", "react/jsx-runtime"].includes(dependency),
                  `unexpected ${entry} dependency: ${dependency} in ${file}`,
                );
              }
            }),
        );
      };
      await visit(`dist/${entry}.${extension}`);
      assert.equal(clientModules.length, entry === "react" && extension === "mjs" ? 1 : 0);
    }),
  );
};
