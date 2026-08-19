import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const packageJSONPath = new URL("../../package.json", import.meta.url);
const readmePath = new URL("../../README.md", import.meta.url);
const distDirectory = new URL("../../dist/", import.meta.url);
const clientEntryPath = new URL("client.mjs", distDirectory);

test("package exposes only its built ESM server and client entries", async () => {
  const packageJSON = JSON.parse(await readFile(packageJSONPath, "utf8"));

  assert.deepEqual(
    {
      artifacts: (await readdir(distDirectory)).sort(),
      exports: packageJSON.exports,
      sideEffects: packageJSON.sideEffects,
      type: packageJSON.type,
    },
    {
      artifacts: ["client.d.mts", "client.mjs", "index.d.mts", "index.mjs"],
      exports: {
        ".": {
          import: "./dist/index.mjs",
          types: "./dist/index.d.mts",
        },
        "./client": {
          import: "./dist/client.mjs",
          types: "./dist/client.d.mts",
        },
      },
      sideEffects: false,
      type: "module",
    },
  );
});

test("server entry exposes the plugin factory", async () => {
  assert.deepEqual(Object.keys(await import("@codlume/payload-activity")), ["activityPlugin"]);
});

test("client artifact retains its client directive", async () => {
  const clientModule = await readFile(clientEntryPath, "utf8");

  assert.match(clientModule, /^"use client";/u);
});

test("declarations expose the options type and plugin factory", async () => {
  const declarations = await readFile(new URL("index.d.mts", distDirectory), "utf8");
  const clientDeclarations = await readFile(new URL("client.d.mts", distDirectory), "utf8");

  assert.match(declarations, /ActivityPluginOptions/u);
  assert.match(declarations, /activityPlugin/u);
  assert.match(clientDeclarations, /LastModifiedByField/u);
});

test("README documents the collection attribution contract", async () => {
  const readme = await readFile(readmePath, "utf8");

  for (const heading of [
    "# Payload Activity",
    "## Configuration",
    "## Attribution behavior",
    "## Disabled mode",
  ]) {
    assert.ok(readme.split("\n").includes(heading), `README is missing ${heading}`);
  }
});
