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

test("the server entry never bundles the client entry", async () => {
  const server = await read("dist/index.mjs");
  const mentions = server.split("@codlume/payload-roles/client").length - 1;
  const imports = server.match(/from ["']@codlume\/payload-roles\/client["']/gu)?.length ?? 0;
  assert.equal(mentions, imports);
});

test("server entry exposes the plugin factory, config error and capabilities helper", async () => {
  assert.deepEqual(Object.keys(await import("@codlume/payload-roles")).sort(), [
    "RolesPluginConfigError",
    "resolveCapabilities",
    "rolesPlugin",
  ]);
  assert.deepEqual(Object.keys(await import("@codlume/payload-roles/client")), []);
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
