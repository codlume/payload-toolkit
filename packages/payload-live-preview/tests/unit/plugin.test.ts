import { sqliteAdapter } from "@payloadcms/db-sqlite";
import type { Config } from "payload";
import { expect, test } from "vitest";
import { livePreviewPlugin } from "../../src/index.ts";

const url = () => {
  throw new Error("URL functions belong to runtime");
};

test.each(["entity", "root", "both", "url-only", "none"] as const)(
  "%s preview configuration registers only eligible collections and globals",
  async (source) => {
    const perEntity = source === "entity" || source === "both";
    const listed = source === "root" || source === "both";
    const config: Config = {
      db: sqliteAdapter({ client: { url: "file::memory:" } }),
      secret: "test",
      admin: {
        livePreview: { url, ...(listed ? { collections: ["pages"], globals: ["home"] } : {}) },
      },
      collections: [
        {
          slug: "pages",
          fields: [],
          admin: {
            ...(perEntity ? { livePreview: { url } } : {}),
            components: {
              beforeList: ["existing#List"],
              edit: {
                beforeDocumentControls: ["existing#Control"],
                PreviewButton: "existing#Preview",
              },
            },
          },
        },
        { slug: "other", fields: [] },
      ],
      globals: [
        {
          slug: "home",
          fields: [],
          admin: {
            ...(perEntity ? { livePreview: { url } } : {}),
            components: {
              elements: {
                beforeDocumentControls: ["existing#Control"],
                PreviewButton: "existing#Preview",
              },
            },
          },
        },
        { slug: "other", fields: [] },
      ],
    };
    if (source === "none") delete config.admin!.livePreview;
    const result = await livePreviewPlugin({ debug: true })(config);
    const controls = [
      "existing#Control",
      ...(perEntity || listed
        ? [
            {
              path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
              clientProps: { debug: true },
            },
          ]
        : []),
    ];
    expect(result.collections?.[0]?.admin?.components?.edit?.beforeDocumentControls).toEqual(
      controls,
    );
    expect(result.globals?.[0]?.admin?.components?.elements?.beforeDocumentControls).toEqual(
      controls,
    );
    expect(result.admin).toBe(config.admin);
    expect(result.collections?.[0]?.fields).toBe(config.collections?.[0]?.fields);
    expect(result.globals?.[0]?.fields).toBe(config.globals?.[0]?.fields);
    expect(result.collections?.[0]?.admin?.components?.beforeList).toEqual(["existing#List"]);
    expect(result.collections?.[0]?.admin?.components?.edit?.PreviewButton).toBe(
      "existing#Preview",
    );
    expect(result.globals?.[0]?.admin?.components?.elements?.PreviewButton).toBe(
      "existing#Preview",
    );
    expect(result.collections?.[1]).toBe(config.collections?.[1]);
    expect(result.globals?.[1]).toBe(config.globals?.[1]);
    expect(config.globals?.[0]?.admin?.components?.elements?.beforeDocumentControls).toEqual([
      "existing#Control",
    ]);
    expect(await livePreviewPlugin({ enabled: false, debug: true })(config)).toBe(config);
  },
);

test("global-only configurations register the bridge with default diagnostics", async () => {
  const config: Config = {
    db: sqliteAdapter({ client: { url: "file::memory:" } }),
    secret: "test",
    globals: [{ slug: "home", fields: [], admin: { livePreview: { url: "https://example.com" } } }],
  };
  const result = await livePreviewPlugin()(config);
  expect(result.globals?.[0]?.admin?.components?.elements?.beforeDocumentControls).toEqual([
    {
      path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
      clientProps: { debug: false },
    },
  ]);
});

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
