import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type Config } from "payload";
import { describe, expect, expectTypeOf, test } from "vitest";

import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";

const buildPluginConfig = (media: NonNullable<Config["collections"]>[number]) =>
  buildConfig({
    collections: [media],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins: [
      blurHashPlugin({
        collections: ["media"],
        enabled: false,
      } satisfies BlurHashPluginOptions),
    ],
    secret: "unit-test-secret",
  });

describe("blurHashPlugin", () => {
  test("requires collections while accepting generated and bootstrap collection slugs", () => {
    expectTypeOf<{}>().not.toMatchTypeOf<BlurHashPluginOptions>();
    expectTypeOf<{ collections: ["media"] }>().toMatchTypeOf<BlurHashPluginOptions>();
    expectTypeOf<{ collections: ["not-yet-generated"] }>().toMatchTypeOf<BlurHashPluginOptions>();
  });

  test("rejects enabled generation without the host Sharp instance", async () => {
    await expect(
      buildConfig({
        collections: [{ fields: [], slug: "media", upload: true }],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        plugins: [blurHashPlugin({ collections: ["media"] })],
        secret: "unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message:
        "Invalid BlurHash plugin configuration:\n- Enabled generation requires Payload's `sharp` option; configure it or set `enabled: false`.",
      name: "BlurHashPluginConfigError",
    });
  });

  test("adds one stored nullable text field to a configured upload collection", async () => {
    const media = {
      fields: [],
      slug: "media",
      upload: true,
    } satisfies NonNullable<Config["collections"]>[number];
    const config = await buildPluginConfig(media);

    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect({
      field,
      isLocalized: field && "localized" in field ? field.localized : false,
    }).toMatchObject({
      field: {
        name: "blurHash",
        required: false,
        type: "text",
        virtual: false,
      },
      isLocalized: false,
    });
  });

  test("keeps the field API-visible but hides it and disables generation when disabled", async () => {
    const config = await buildPluginConfig({ fields: [], slug: "media", upload: true });
    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect({
      generationHooks: field && "hooks" in field ? field.hooks?.beforeChange : undefined,
      hidden: field?.admin && "hidden" in field.admin ? field.admin.hidden : undefined,
      hiddenFromAPI: field && "hidden" in field ? field.hidden : undefined,
    }).toEqual({
      generationHooks: undefined,
      hidden: true,
      hiddenFromAPI: undefined,
    });
  });

  test("adds one custom-named field to every configured collection only", async () => {
    const sourceConfig = {
      collections: [
        { fields: [], slug: "media", upload: true },
        { fields: [], slug: "assets", upload: true },
        { fields: [], slug: "pages" },
      ],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
    } satisfies Config;
    const transformed = await blurHashPlugin({
      collections: ["media", "assets"],
      enabled: false,
      fieldName: "placeholder",
    })(sourceConfig);

    expect(
      transformed.collections?.map((collection) => ({
        fields: collection.fields.flatMap((field) => ("name" in field ? [field.name] : [])),
        slug: collection.slug,
      })),
    ).toEqual([
      { fields: ["placeholder"], slug: "media" },
      { fields: ["placeholder"], slug: "assets" },
      { fields: [], slug: "pages" },
    ]);
  });

  test("reports deterministic configuration problems together", async () => {
    const options = {
      alphaBackground: { b: 255, g: 255, r: -1 },
      collections: ["media", "media", "missing", "pages"],
      fieldName: "url",
      limits: { concurrency: 0, timeoutSeconds: 1.5 },
    } satisfies BlurHashPluginOptions;
    const firstPlugin = blurHashPlugin(options);
    const secondPlugin = blurHashPlugin({ collections: ["media"], enabled: false });

    await expect(
      buildConfig({
        collections: [
          {
            fields: [{ name: "url", type: "text" }],
            slug: "media",
            upload: true,
          },
          { fields: [], slug: "pages" },
        ],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        plugins: [firstPlugin, secondPlugin],
        secret: "unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- `collections` must not contain duplicate slug "media".',
        '- `fieldName` "url" is reserved by Payload; choose a plugin-owned field name.',
        "- `alphaBackground.r` must be an integer from 0 through 255; received -1.",
        "- `limits.concurrency` must be a positive safe integer; received 0.",
        "- `limits.timeoutSeconds` must be a positive safe integer; received 1.5.",
        "- Register `blurHashPlugin` only once; found 2 registrations.",
        '- Collection "media" already has a top-level data-bearing field named "url".',
        '- Collection "missing" does not exist.',
        '- Collection "pages" must be upload-enabled.',
        "- Enabled generation requires Payload's `sharp` option; configure it or set `enabled: false`.",
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("validates collection requirements while disabled", async () => {
    await expect(
      buildConfig({
        collections: [{ fields: [], slug: "media", upload: true }],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        plugins: [blurHashPlugin({ collections: [], enabled: false })],
        secret: "unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message:
        "Invalid BlurHash plugin configuration:\n- `collections` must be a non-empty array of upload collection slugs.",
      name: "BlurHashPluginConfigError",
    });
  });

  test("rejects internal or unsafe generated field names", async () => {
    await expect(
      buildConfig({
        collections: [{ fields: [], slug: "media", upload: true }],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        plugins: [
          blurHashPlugin({
            collections: ["media"],
            enabled: false,
            fieldName: "_blur.hash",
          }),
        ],
        secret: "unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- `fieldName` "_blur.hash" must start with a letter and contain only letters, numbers, or underscores.',
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("accepts RGB boundaries and explicit positive safe limits without hidden ceilings", async () => {
    const config = await buildConfig({
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [
        blurHashPlugin({
          alphaBackground: { b: 255, g: 0, r: 255 },
          collections: ["media"],
          debug: true,
          enabled: false,
          limits: {
            concurrency: Number.MAX_SAFE_INTEGER,
            maxInputBytes: Number.MAX_SAFE_INTEGER,
            maxInputPixels: Number.MAX_SAFE_INTEGER,
            maxInputSide: Number.MAX_SAFE_INTEGER,
            timeoutSeconds: Number.MAX_SAFE_INTEGER,
          },
        }),
      ],
      secret: "unit-test-secret",
    });

    expect(config.collections[0]?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "blurHash", type: "text" })]),
    );
  });

  test("returns a new config and collection array without cloning unmanaged collections", async () => {
    const media = {
      fields: [],
      slug: "media",
      upload: true,
    } satisfies NonNullable<Config["collections"]>[number];
    const pages = {
      fields: [],
      slug: "pages",
    } satisfies NonNullable<Config["collections"]>[number];
    const sourceConfig: Config = {
      collections: [media, pages],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
    };
    const transformed = await blurHashPlugin({ collections: ["media"], enabled: false })(
      sourceConfig,
    );

    expect({
      collectionArrayWasCloned: transformed.collections !== sourceConfig.collections,
      configuredCollectionWasCloned: transformed.collections?.[0] !== media,
      configWasCloned: transformed !== sourceConfig,
      sourceFields: media.fields,
      unmanagedCollectionWasPreserved: transformed.collections?.[1] === pages,
    }).toEqual({
      collectionArrayWasCloned: true,
      configuredCollectionWasCloned: true,
      configWasCloned: true,
      sourceFields: [],
      unmanagedCollectionWasPreserved: true,
    });
  });

  test("leaves the source collection unchanged", async () => {
    const media = {
      fields: [],
      slug: "media",
      upload: true,
    } satisfies NonNullable<Config["collections"]>[number];

    await buildPluginConfig(media);

    expect(media.fields).toEqual([]);
  });
});
