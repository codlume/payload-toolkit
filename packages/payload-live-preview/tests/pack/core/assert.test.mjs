import assert from "node:assert/strict";
import test from "node:test";
import { assertAbsent, assertPackage, assertFrontendGraph } from "./assert-package.mjs";

void test("core is isolated and its installed graph contains no framework dependencies", async () => {
  await assertAbsent(["react", "react-dom", "payload", "@payloadcms/ui", "next"]);
  await assertPackage();
  await assertFrontendGraph("core");
});

void test("importing core does not access browser globals or install listeners", async () => {
  for (const name of ["window", "document", "MutationObserver"]) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      get() {
        throw new Error(`core import accessed ${name}`);
      },
    });
  }
  try {
    const core = await import("@codlume/payload-live-preview/core");
    assert.deepEqual(Object.keys(core).toSorted(), ["blockMarker", "createPreviewBridge"]);
    assert.deepEqual(core.blockMarker({ id: "row-1", blockType: "text" }, { draft: true }), {
      "data-payload-block": "row-1",
      "data-payload-block-type": "text",
    });
    assert.deepEqual(core.blockMarker({ id: "row-1", blockType: "text" }, { draft: false }), {});
    assert.deepEqual(core.blockMarker({ blockType: "text" }, { draft: true }), {});
  } finally {
    for (const name of ["window", "document", "MutationObserver"]) delete globalThis[name];
  }
  const { createPreviewBridge } = await import("@codlume/payload-live-preview/core");
  assert.doesNotThrow(() => createPreviewBridge({ serverURL: "https://cms.example.com" })());
});
