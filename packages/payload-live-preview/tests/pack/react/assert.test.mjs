import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as reactEntry from "@codlume/payload-live-preview/react";
import { assertAbsent, assertPackage, assertFrontendGraph } from "./assert-package.mjs";

void test("React frontend installs and declares its API without Payload or Admin", async () => {
  await assertAbsent(["payload", "@payloadcms/ui"]);
  await assertPackage();
  await assertFrontendGraph("core");
  await assertFrontendGraph("react");
  assert.deepEqual(Object.keys(reactEntry).toSorted(), ["PreviewBridge", "createBlockRenderer"]);
});

void test("the packed renderer omits unknown runtime types and adds no wrapper", () => {
  const Blocks = reactEntry.createBlockRenderer({
    text: ({ block, marker }) => createElement("p", marker, block.content),
  });
  assert.equal(
    renderToStaticMarkup(
      createElement(Blocks, {
        blocks: [
          { id: "text-1", blockType: "text", content: "Hello" },
          { id: "unknown-1", blockType: "new-type" },
        ],
      }),
    ),
    "<p>Hello</p>",
  );
});

void test("a server module calls the factory and renders the separate client bridge", async () => {
  const html = await readFile(new URL("./out/index.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<main><section data-payload-block="section-1" data-payload-block-type="section"><p data-payload-block="text-1" data-payload-block-type="text">Server: (?:<!-- -->)?Nested text<\/p><\/section><section><p>Published: (?:<!-- -->)?Nested text<\/p><\/section><\/main>/u,
  );
});

void test("a client module uses the same entry and forwards draft and parent props", async () => {
  const html = await readFile(new URL("./out/client.html", import.meta.url), "utf8");
  assert.match(
    html,
    /<main><section data-payload-block="section-1" data-payload-block-type="section"><p data-payload-block="text-1" data-payload-block-type="text">Client: (?:<!-- -->)?Nested text<\/p><\/section><\/main>/u,
  );
});
