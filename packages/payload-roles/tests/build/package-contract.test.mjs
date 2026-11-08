import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const packageURL = new URL("../../", import.meta.url);
const read = (file) => readFile(new URL(file, packageURL), "utf8");
const manifest = JSON.parse(await read("package.json"));

test("package exposes exactly the server and client ESM entries", async () => {
  assert.deepEqual(
    {
      artifacts: (await readdir(new URL("dist/", packageURL))).sort(),
      exports: manifest.exports,
      sideEffects: manifest.sideEffects,
      type: manifest.type,
    },
    {
      artifacts: ["client.d.mts", "client.mjs", "index.d.mts", "index.mjs"],
      exports: {
        ".": { import: "./dist/index.mjs", types: "./dist/index.d.mts" },
        "./client": { import: "./dist/client.mjs", types: "./dist/client.d.mts" },
      },
      sideEffects: false,
      type: "module",
    },
  );
});

test("package stays private at 0.0.0 until final integration", () => {
  assert.deepEqual(
    { private: manifest.private, version: manifest.version, publishConfig: manifest.publishConfig },
    { private: true, version: "0.0.0", publishConfig: undefined },
  );
});

test("only the client entry carries the use client directive", async () => {
  assert.match(await read("dist/client.mjs"), /^["']use client["'];/u);
  assert.doesNotMatch(await read("dist/index.mjs"), /["']use client["']/u);
});

// The client entry cannot load in plain Node (it reaches CSS through @payloadcms/ui), while the
// server entry must, because Payload configs load outside Next. Server code may reach client
// components only through a deferred `import("@codlume/payload-roles/client")`. Bundled client
// code is caught elsewhere: shared code would add a file to the pinned dist list, and a static
// load breaks the plain-Node import of the server entry below.
const serverBoundaryProblems = (server) => [
  ...(/(?:from|import)\s*["']@codlume\/payload-roles\/client["']/u.test(server)
    ? ["static import of the client entry"]
    : []),
  ...(/["']\.{1,2}\/client\.mjs["']/u.test(server) ? ["relative import of the client build"] : []),
];

test("the server boundary check accepts deferred client imports and rejects static ones", () => {
  assert.deepEqual(
    serverBoundaryProblems(
      'const { PermissionsMatrix } = await import("@codlume/payload-roles/client");\nconst path = "@codlume/payload-roles/client#PermissionsMatrix";',
    ),
    [],
  );
  for (const source of [
    'import { PermissionsMatrix } from "@codlume/payload-roles/client";',
    'import "@codlume/payload-roles/client";',
    'export * from "@codlume/payload-roles/client";',
  ]) {
    assert.deepEqual(serverBoundaryProblems(source), ["static import of the client entry"], source);
  }
  assert.deepEqual(serverBoundaryProblems('const m = await import("./client.mjs");'), [
    "relative import of the client build",
  ]);
});

test("the server entry reaches the client entry only through deferred imports", async () => {
  assert.deepEqual(serverBoundaryProblems(await read("dist/index.mjs")), []);
});

test("server entry exposes the plugin factory, config error and capabilities helper", async () => {
  const exported = Object.keys(await import("@codlume/payload-roles"));
  for (const name of ["RolesPluginConfigError", "resolveCapabilities", "rolesPlugin"]) {
    assert.ok(exported.includes(name), `server entry is missing ${name}`);
  }
});

test("declarations expose the options type and the public contract types", async () => {
  const declarations = await read("dist/index.d.mts");
  for (const name of ["RolesPluginOptions", "rolesPlugin", "Capabilities", "ActionId", "resolveCapabilities"]) {
    assert.match(declarations, new RegExp(`\\b${name}\\b`, "u"));
  }
});

test("README documents the contract the plugin enforces today", async () => {
  const readme = await read("README.md");
  for (const heading of [
    "# Payload Roles",
    "## Compatibility",
    "## Configuration",
    "## What core enforces",
    "## Interim: lifecycle not installed",
    "## Trusted boundaries",
    "## Disabled mode",
    "## Limitations",
  ]) {
    assert.ok(readme.split("\n").includes(heading), `README is missing ${heading}`);
  }
});
