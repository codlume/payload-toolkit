import assert from "node:assert/strict";
import test from "node:test";
import * as client from "@codlume/payload-live-preview/client";
import { importMap } from "./import-map.mjs";

void test("the generated Admin import map resolves the packed named client export", () => {
  assert.deepEqual(Object.keys(client), ["PreviewBridgeAdmin"]);
  assert.equal(typeof client.PreviewBridgeAdmin, "function");
  assert.equal(
    importMap["@codlume/payload-live-preview/client#PreviewBridgeAdmin"],
    client.PreviewBridgeAdmin,
  );
});
