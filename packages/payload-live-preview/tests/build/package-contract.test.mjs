import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageURL = new URL("../../", import.meta.url);
const read = (file) => readFile(new URL(file, packageURL), "utf8");
const manifest = JSON.parse(await read("package.json"));

const importGraph = async (entry) => {
  const modules = new Map();
  const visit = async (url) => {
    if (modules.has(url.href)) return;
    const source = await readFile(url, "utf8");
    modules.set(url.href, source);
    for (const match of source.matchAll(/\bfrom\s+["'](\.[^"']+)["']/g)) {
      const dependency = entry.endsWith(".d.mts") ? match[1].replace(/\.mjs$/, ".d.mts") : match[1];
      await visit(new URL(dependency, url));
    }
  };
  await visit(new URL(entry, packageURL));
  return modules;
};

test("four compiled public entries carry explicit declarations and private module boundaries", async () => {
  assert.deepEqual(Object.keys(manifest.exports), [".", "./core", "./react", "./client"]);
  for (const mapping of Object.values(manifest.exports)) {
    assert.match(mapping.import, /\.mjs$/);
    assert.match(mapping.types, /\.d\.mts$/);
    await read(mapping.import);
    await read(mapping.types);
  }
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(manifest.peerDependencies, {
    payload: ">=3.88.0 <4", "@payloadcms/ui": ">=3.88.0 <4", react: "^19.0.1 || ^19.1.2 || ^19.2.1",
  });
  assert.ok(Object.values(manifest.peerDependenciesMeta).every(peer => peer.optional));
});

test("public frontend graphs exclude Admin and only the bridge component is client-marked", async () => {
  const reactEntry = manifest.exports["./react"];
  assert.doesNotMatch(await read(reactEntry.import), /["']use client["']/);
  for (const entry of [manifest.exports["./core"], reactEntry]) {
    const javascript = await importGraph(entry.import);
    let clientModules = 0;
    for (const js of javascript.values()) {
      assert.doesNotMatch(js, /from ["'](?:payload|@payloadcms\/ui|@codlume\/payload-live-preview["'])/);
      if (/^["']use client["'];/.test(js)) clientModules++;
    }
    assert.equal(clientModules, entry === reactEntry ? 1 : 0);
    for (const declaration of (await importGraph(entry.types)).values()) {
      assert.doesNotMatch(declaration, /from ["'](?:payload|@payloadcms\/ui|@codlume\/payload-live-preview["'])/);
    }
  }
  assert.match(await read(manifest.exports["./client"].import), /^["']use client["'];/);
  const core = await import("@codlume/payload-live-preview/core");
  assert.deepEqual(core.blockMarker({ id: "one", blockType: "text" }, { draft: false }), {});
  assert.doesNotThrow(() => core.createPreviewBridge({ serverURL: "https://admin.example" })());
  const react = await import("@codlume/payload-live-preview/react");
  assert.equal(typeof react.createBlockRenderer({ text: () => null }), "function");
});
