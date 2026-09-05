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
  await payload.update({
    collection: "pages",
    id: published.id,
    draft: true,
    user: admin,
    overrideAccess: false,
    data: { layout: [{ ...published.layout![0]!, content: "Draft content" }] },
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
    published: publicRead.layout?.[0]?.content,
    draft: draftRead.layout?.[0]?.content,
    id: draftRead.layout?.[0]?.id,
  }).toEqual({
    published: "Published content",
    draft: "Draft content",
    id: published.layout?.[0]?.id,
  });
});
