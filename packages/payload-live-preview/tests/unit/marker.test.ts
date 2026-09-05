import { expect, test } from "vitest";
import { blockMarker } from "../../src/core.ts";

test("draft blocks expose their existing row identity and display type", () => {
  expect(
    blockMarker({ id: "row-1", blockType: "text", content: "hello" }, { draft: true }),
  ).toEqual({
    "data-payload-block": "row-1",
    "data-payload-block-type": "text",
  });
});

test.each([
  [{ id: "row-1", blockType: "text" }, false],
  [{ blockType: "text" }, true],
  [{ id: null, blockType: "text" }, true],
  [{ id: "", blockType: "text" }, true],
] as const)("published or unidentified blocks omit both attributes", (block, draft) => {
  expect(blockMarker(block, { draft })).toEqual({});
});
