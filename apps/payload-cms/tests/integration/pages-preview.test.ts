import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createAppConfig } from "../../src/app-config.ts";

let payload: Payload;
let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "payload-pages-preview-"));
  payload = await getPayload({
    config: await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(directory, "payload.db")}`,
      generatedFiles: {
        importMap: path.join(directory, "importMap.js"),
        types: path.join(directory, "types.ts"),
      },
      mediaBeforeChangeHooks: [],
      mode: "enabled-in-memory",
      storage: false,
      uploadDirectory: path.join(directory, "media"),
    }),
  });
});
afterAll(async () => {
  await payload?.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("authenticated draft reads retain row ids while public reads stay published", async () => {
  const admin = await payload.create({
    collection: "users",
    data: { email: "pages@example.com", name: "Pages Admin", password: "pages-password" },
  });
  const published = await payload.create({
    collection: "pages",
    data: {
      title: "Example",
      slug: "example",
      _status: "published",
      layout: [{ blockType: "text", content: "Published content" }],
    },
    user: admin,
    overrideAccess: false,
  });
  const text = published.layout![0]!;
  if (text.blockType !== "text") throw new Error("Missing text block");
  await payload.update({
    collection: "pages",
    id: published.id,
    draft: true,
    user: admin,
    overrideAccess: false,
    data: { layout: [{ ...text, content: "Draft content" }] },
  });
  const publicRead = await payload.findByID({
    collection: "pages",
    id: published.id,
    overrideAccess: false,
  });
  const draftRead = await payload.findByID({
    collection: "pages",
    id: published.id,
    draft: true,
    user: admin,
    overrideAccess: false,
  });
  expect({
    published:
      publicRead.layout?.[0]?.blockType === "text" ? publicRead.layout[0].content : undefined,
    draft: draftRead.layout?.[0]?.blockType === "text" ? draftRead.layout[0].content : undefined,
    id: draftRead.layout?.[0]?.id,
  }).toEqual({
    published: "Published content",
    draft: "Draft content",
    id: published.layout?.[0]?.id,
  });
});

test("nested block ids survive draft saves, sibling reordering and deletion", async () => {
  const created = await payload.create({
    collection: "pages",
    data: {
      title: "Nested",
      slug: "nested",
      layout: [
        { blockType: "text", content: "Sibling" },
        {
          blockType: "section",
          heading: "Outer",
          content: [
            {
              blockType: "section",
              heading: "Inner",
              content: [{ blockType: "text", content: "Deep" }],
            },
          ],
        },
      ],
    },
  });
  const [sibling, outer] = created.layout!;
  expect(outer?.blockType).toBe("section");
  if (outer?.blockType !== "section") throw new Error("Missing outer section");
  const inner = outer.content![0]!;
  if (inner.blockType !== "section") throw new Error("Missing inner section");
  const deep = inner.content![0]!;
  const ids = [sibling!.id, outer.id, inner.id, deep.id];
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(4);
  await payload.update({
    collection: "pages",
    id: created.id,
    draft: true,
    data: { layout: [outer, sibling!] },
  });
  const reordered = await payload.findByID({ collection: "pages", id: created.id, draft: true });
  expect(reordered.layout).toEqual([outer, sibling]);
  await payload.update({
    collection: "pages",
    id: created.id,
    draft: true,
    data: { layout: [outer] },
  });
  const removed = await payload.findByID({ collection: "pages", id: created.id, draft: true });
  expect(removed.layout).toEqual([outer]);
});
