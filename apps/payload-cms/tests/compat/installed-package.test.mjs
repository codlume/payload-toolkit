import assert from "node:assert/strict";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const applicationDirectory = fileURLToPath(new URL("../../", import.meta.url));
const applicationPackageJSON = JSON.parse(
  await readFile(path.join(applicationDirectory, "package.json"), "utf8"),
);
const verifiedPeerRanges = {
  "@codlume/payload-activity": { payload: ">=3.88.0 <4" },
  "@codlume/payload-blurhash": { "@payloadcms/ui": ">=3.88.0 <4", payload: ">=3.88.0 <4" },
  "@codlume/payload-live-preview": { "@payloadcms/ui": ">=3.88.0 <4", payload: ">=3.88.0 <4" },
};
const pluginNames = Object.keys(verifiedPeerRanges);
const installedPlugins = Object.fromEntries(
  await Promise.all(
    pluginNames.map(async (name) => {
      const serverEntryPath = fileURLToPath(import.meta.resolve(name));
      const directory = path.dirname(path.dirname(serverEntryPath));
      const packageJSON = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));

      return [name, { directory, packageJSON, serverEntryPath }];
    }),
  ),
);

void test("the consumer resolves the real tarballs inside its own installation", async () => {
  const [applicationPath, lockfile, installedPackagePaths] = await Promise.all([
    realpath(applicationDirectory),
    readFile(path.join(applicationDirectory, "pnpm-lock.yaml"), "utf8"),
    Promise.all(
      Object.entries(installedPlugins).map(async ([name, plugin]) => {
        const [directory, serverEntryPath] = await Promise.all([
          realpath(plugin.directory),
          realpath(plugin.serverEntryPath),
        ]);
        return [name, { directory, serverEntryPath }];
      }),
    ),
  ]);

  assert.deepEqual(
    Object.fromEntries(
      installedPackagePaths.map(([name, installedPackage]) => [
        name,
        {
          builtServerEntry: installedPackage.serverEntryPath.endsWith(
            path.join("dist", "index.mjs"),
          ),
          installedInsideConsumer: installedPackage.directory.startsWith(applicationPath),
          workspaceReference: /workspace:/u.test(lockfile),
        },
      ]),
    ),
    Object.fromEntries(
      pluginNames.map((name) => [
        name,
        {
          builtServerEntry: true,
          installedInsideConsumer: true,
          workspaceReference: false,
        },
      ]),
    ),
  );
});

void test("the installed packages make only the verified compatibility claims", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(installedPlugins).map(([name, { packageJSON }]) => [
        name,
        {
          engines: packageJSON.engines,
          payloadPeers: Object.fromEntries(
            Object.entries(packageJSON.peerDependencies).filter(
              ([peer]) => peer === "payload" || peer.startsWith("@payloadcms/"),
            ),
          ),
        },
      ]),
    ),
    Object.fromEntries(
      Object.entries(verifiedPeerRanges).map(([name, payloadPeers]) => [
        name,
        {
          engines: { node: ">=22.12.0 <23 || >=24.0.0 <25" },
          payloadPeers,
        },
      ]),
    ),
  );
});

void test("every host dependency is exactly pinned and installed at that version", async () => {
  const declaredDependencies = {
    ...applicationPackageJSON.dependencies,
    ...applicationPackageJSON.devDependencies,
  };
  for (const pluginName of pluginNames) {
    delete declaredDependencies[pluginName];
  }
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
