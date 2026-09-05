import { sqliteAdapter } from "@payloadcms/db-sqlite";
import type { Config } from "payload";
import { expect, test } from "vitest";
import { livePreviewPlugin } from "../../src/index.ts";

test("a native collection preview appends the bridge and preserves controls", async () => {
  const config: Config = {
    db: sqliteAdapter({ client: { url: "file::memory:" } }),
    secret: "test",
    collections: [
      {
        slug: "pages",
        fields: [],
        admin: {
          livePreview: {
            url: () => {
              throw new Error("must not evaluate");
            },
          },
          components: { edit: { beforeDocumentControls: ["existing#Control"] } },
        },
      },
      { slug: "other", fields: [] },
    ],
  };
  const result = await livePreviewPlugin()(config);
  expect(
    result.collections?.map(
      (collection) => collection.admin?.components?.edit?.beforeDocumentControls,
    ),
  ).toEqual([
    [
      "existing#Control",
      {
        path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
        clientProps: { debug: false },
      },
    ],
    undefined,
  ]);
});

test("disabled mode is a complete no-op even with debug enabled", async () => {
  const config: Config = {
    db: sqliteAdapter({ client: { url: "file::memory:" } }),
    secret: "test",
    collections: [
      { slug: "pages", fields: [], admin: { livePreview: { url: "https://example.com" } } },
    ],
  };
  expect(await livePreviewPlugin({ enabled: false, debug: true })(config)).toBe(config);
});

test("debug is forwarded to the Admin bridge without evaluating preview URLs", async () => {
  const config: Config = {
    db: sqliteAdapter({ client: { url: "file::memory:" } }),
    secret: "test",
    collections: [
      { slug: "pages", fields: [], admin: { livePreview: { url: "https://example.com" } } },
    ],
  };
  const result = await livePreviewPlugin({ debug: true })(config);
  expect(result.collections?.[0]?.admin?.components?.edit?.beforeDocumentControls).toEqual([
    {
      path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
      clientProps: { debug: true },
    },
  ]);
  expect(config.collections?.[0]?.admin?.components).toBeUndefined();
});
