import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = (file) => readFile(new URL(`../../${file}`, import.meta.url), "utf8");

test("four compiled public entries carry explicit declarations and private module boundaries", async () => {
  const manifest = JSON.parse(await read("package.json"));
  assert.deepEqual(Object.keys(manifest.exports), [".", "./core", "./react", "./client"]);
  for (const mapping of Object.values(manifest.exports)) {
    assert.match(mapping.import, /\.mjs$/);
    assert.match(mapping.types, /\.d\.mts$/);
    await read(mapping.import);
    await read(mapping.types);
  }
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.peerDependencies, { payload: ">=3.88.0 <4", "@payloadcms/ui": ">=3.88.0 <4", react: "^19.0.1 || ^19.1.2 || ^19.2.1" });
  assert.ok(Object.values(manifest.peerDependenciesMeta).every(peer => peer.optional));
});

test("only the two bridge components carry client directives; frontend modules exclude Admin", async () => {
  for (const name of ["core", "react", "renderer", "marker", "bridge", "visuals", "channel"]) {
    const js = await read(`dist/${name}.mjs`);
    assert.doesNotMatch(js, /["']use client["']/);
    assert.doesNotMatch(js, /from ["'](?:payload|@payloadcms\/ui|\.\/index)/);
  }
  for (const name of ["core", "react", "renderer", "marker", "bridge", "preview-bridge"]) {
    assert.doesNotMatch(await read(`dist/${name}.d.mts`), /from ["'](?:payload|@payloadcms\/ui|\.\/index)/);
  }
  for (const name of ["client", "preview-bridge"]) {
    assert.match(await read(`dist/${name}.mjs`), /^["']use client["'];/);
  }
  const core = await import("../../dist/core.mjs");
  assert.deepEqual(core.blockMarker({ id: "one", blockType: "text" }, { draft: false }), {});
  assert.doesNotThrow(() => core.createPreviewBridge({ serverURL: "https://admin.example" })());
  const react = await import("../../dist/react.mjs");
  assert.equal(typeof react.createBlockRenderer({ text: () => null }), "function");
});
