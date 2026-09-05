import assert from "node:assert/strict";
import test from "node:test";
import * as root from "@codlume/payload-live-preview";
import { getPayload } from "payload";
import config from "./payload.config.js";
import { assertPackage, assertFrontendGraph } from "./assert-package.mjs";

void test("Payload 3.88 initializes with the packed configuration entry", async () => {
  await assertPackage();
  await assertFrontendGraph("core");
  await assertFrontendGraph("react");
  assert.deepEqual(Object.keys(root), ["livePreviewPlugin"]);
  const payload = await getPayload({ config });
  try {
    const pageConfig = payload.config.collections.find(({ slug }) => slug === "pages");
    assert.deepEqual(pageConfig.admin.components.edit.beforeDocumentControls, [
      {
        path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
        clientProps: { debug: false },
      },
    ]);
  } finally {
    await payload.destroy();
  }
});
