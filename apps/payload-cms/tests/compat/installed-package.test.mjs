import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const applicationDirectory = fileURLToPath(new URL("../../", import.meta.url));
const applicationPackageJSON = JSON.parse(
  await readFile(path.join(applicationDirectory, "package.json"), "utf8"),
);
const serverEntryPath = fileURLToPath(import.meta.resolve("@codlume/payload-blurhash"));
const installedPackageDirectory = path.dirname(path.dirname(serverEntryPath));
const installedPackageJSON = JSON.parse(
  await readFile(path.join(installedPackageDirectory, "package.json"), "utf8"),
);

void test("the consumer resolves the real tarball inside its own installation", async () => {
  const [applicationPath, installedPackagePath, lockfile] = await Promise.all([
    realpath(applicationDirectory),
    realpath(installedPackageDirectory),
    readFile(path.join(applicationDirectory, "pnpm-lock.yaml"), "utf8"),
  ]);

  assert.deepEqual(
    {
      builtServerEntry: serverEntryPath.endsWith(path.join("dist", "index.mjs")),
      installedInsideConsumer: installedPackagePath.startsWith(applicationPath),
      workspaceReference: /workspace:/u.test(lockfile),
    },
    {
      builtServerEntry: true,
      installedInsideConsumer: true,
      workspaceReference: false,
    },
  );
});

void test("the installed package makes only the verified compatibility claims", () => {
  assert.deepEqual(
    {
      engines: installedPackageJSON.engines,
      payload: installedPackageJSON.peerDependencies.payload,
      payloadUI: installedPackageJSON.peerDependencies["@payloadcms/ui"],
    },
    {
      engines: { node: ">=22.12.0 <23 || >=24.0.0 <25" },
      payload: ">=3.88.0 <4",
      payloadUI: ">=3.88.0 <4",
    },
  );
});

void test("every host dependency is exactly pinned and installed at that version", async () => {
  const declaredDependencies = {
    ...applicationPackageJSON.dependencies,
    ...applicationPackageJSON.devDependencies,
  };
  delete declaredDependencies["@codlume/payload-blurhash"];
  const installedVersions = Object.fromEntries(
    await Promise.all(
      Object.entries(declaredDependencies).map(async ([name]) => {
        const manifest = JSON.parse(
          await readFile(path.join(applicationDirectory, "node_modules", name, "package.json")),
        );
        return [name, manifest.version];
      }),
    ),
  );

  assert.deepEqual(installedVersions, declaredDependencies);
});
