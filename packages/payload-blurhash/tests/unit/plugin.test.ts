import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type Config, type FieldHook, type SharpDependency } from "payload";
import hostSharp from "sharp";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { createConcurrencySharp, createHangingSharp } from "./sharp-test-helpers.ts";

const fixtureDirectory = new URL(
  "../../../../apps/payload-cms/tests/fixtures/images/",
  import.meta.url,
);

const createMetadataProbeSharp = (
  width: number,
  height: number,
  recordNormalization: () => void,
): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      Object.defineProperty(pipeline, "metadata", {
        value: async () => ({ format: "jpeg", height, pages: 1, width }),
      });
    } else {
      recordNormalization();
    }

    return pipeline;
  }) satisfies SharpDependency;

const getBlurHashHook = (config: Config, collectionSlug: string): FieldHook => {
  const collection = config.collections?.find(({ slug }) => slug === collectionSlug);
  const field = collection?.fields.find(
    (candidate) => "name" in candidate && candidate.name === "blurHash",
  );
  const hook = field && "hooks" in field ? field.hooks?.beforeChange?.[0] : undefined;

  if (!hook) {
    throw new TypeError(`Expected ${collectionSlug} to have a BlurHash lifecycle hook`);
  }

  return hook;
};

const buildPayloadConfig = (
  collections: NonNullable<Config["collections"]>,
  plugins: NonNullable<Config["plugins"]>,
) =>
  buildConfig({
    collections,
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins,
    secret: "unit-test-secret",
  });

describe("blurHashPlugin", () => {
  test("requires configured collections", () => {
    expectTypeOf<{}>().not.toMatchTypeOf<BlurHashPluginOptions>();
  });

  test("accepts collection strings before generated types exist", () => {
    expectTypeOf<{ collections: ["not-yet-generated"] }>().toMatchTypeOf<BlurHashPluginOptions>();
  });

  test("rejects enabled generation without the host Sharp instance", async () => {
    await expect(
      buildPayloadConfig(
        [{ fields: [], slug: "media", upload: true }],
        [blurHashPlugin({ collections: ["media"] })],
      ),
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
    const config = await buildPayloadConfig(
      [media],
      [blurHashPlugin({ collections: ["media"], enabled: false })],
    );

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

  test("keeps the disabled field API-visible and hidden in Admin", async () => {
    const config = await buildPayloadConfig(
      [{ fields: [], slug: "media", upload: true }],
      [blurHashPlugin({ collections: ["media"], enabled: false })],
    );
    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect({
      hidden: field?.admin && "hidden" in field.admin ? field.admin.hidden : undefined,
      hiddenFromAPI: field && "hidden" in field ? field.hidden : undefined,
    }).toEqual({
      hidden: true,
      hiddenFromAPI: undefined,
    });
  });

  test("renders the preview component at the enabled generated field", async () => {
    const config = await buildConfig({
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [blurHashPlugin({ collections: ["media"] })],
      secret: "unit-test-secret",
      sharp: hostSharp,
    });
    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect(field).toMatchObject({
      admin: {
        components: {
          Field: "@codlume/payload-blurhash/client#BlurHashPreview",
        },
        readOnly: true,
        width: "100%",
      },
      label: "BlurHash",
    });
  });

  test("makes the generated field read-only in Admin", async () => {
    const config = await buildPayloadConfig(
      [{ fields: [], slug: "media", upload: true }],
      [blurHashPlugin({ collections: ["media"], enabled: false })],
    );
    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect(field?.type === "text" ? field.admin?.readOnly : undefined).toBe(true);
  });

  test.each(["create", "update"] as const)("denies caller %s access", async (operation) => {
    const config = await buildPayloadConfig(
      [{ fields: [], slug: "media", upload: true }],
      [blurHashPlugin({ collections: ["media"], enabled: false })],
    );
    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );
    const access = field && "access" in field ? field.access?.[operation] : undefined;

    if (!access) {
      throw new TypeError(`Expected the generated field to deny ${operation} access`);
    }

    expect(Reflect.apply(access, undefined, [{}])).toBe(false);
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

  test("shares one generation queue across configured collections", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    let maximumActive = 0;
    const sharp = createConcurrencySharp((active) => {
      maximumActive = Math.max(maximumActive, active);
    });
    const sourceConfig = {
      collections: [
        { fields: [], slug: "media", upload: true },
        { fields: [], slug: "assets", upload: true },
      ],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
      sharp,
    } satisfies Config;
    const transformed = await blurHashPlugin({
      collections: ["media", "assets"],
      limits: { concurrency: 1 },
    })(sourceConfig);
    const hooks = [getBlurHashHook(transformed, "media"), getBlurHashHook(transformed, "assets")];
    const args = {
      data: { mimeType: "image/jpeg" },
      req: { file: { data: input }, payload: { config: { sharp } } },
    };

    await Promise.all(hooks.map((hook) => Reflect.apply(hook, undefined, [args])));

    expect(maximumActive).toBe(1);
  });

  test("defaults queue concurrency from the available processor count", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const expectedConcurrency = availableParallelism() === 1 ? 1 : 2;
    let maximumActive = 0;
    const sharp = createConcurrencySharp((active) => {
      maximumActive = Math.max(maximumActive, active);
    });
    const sourceConfig = {
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
      sharp,
    } satisfies Config;
    const transformed = await blurHashPlugin({ collections: ["media"] })(sourceConfig);
    const hook = getBlurHashHook(transformed, "media");
    const args = {
      data: { mimeType: "image/jpeg" },
      req: { file: { data: input }, payload: { config: { sharp } } },
    };

    await Promise.all(
      Array.from({ length: expectedConcurrency + 1 }, () => Reflect.apply(hook, undefined, [args])),
    );

    expect(maximumActive).toBe(expectedConcurrency);
  });

  test("enforces the default compressed-input limit before decode", async () => {
    let sharpCalls = 0;
    const controlledSharp = ((input, options) => {
      sharpCalls += 1;
      return hostSharp(input, options);
    }) satisfies SharpDependency;
    const sourceConfig = {
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
      sharp: controlledSharp,
    } satisfies Config;
    const transformed = await blurHashPlugin({ collections: ["media"] })(sourceConfig);
    const outcome = await Reflect.apply(getBlurHashHook(transformed, "media"), undefined, [
      {
        data: { mimeType: "image/jpeg" },
        req: {
          file: { data: Buffer.alloc(25 * 1024 * 1024 + 1) },
          payload: { config: { sharp: controlledSharp } },
        },
      },
    ]);

    expect({ outcome, sharpCalls }).toEqual({ outcome: null, sharpCalls: 0 });
  });

  test.each([
    [16_385, 1],
    [10_001, 4_000],
  ])("enforces default decoded limits before normalization for %s × %s", async (width, height) => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    let normalizationCalls = 0;
    const sharp = createMetadataProbeSharp(width, height, () => {
      normalizationCalls += 1;
    });
    const sourceConfig = {
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
      sharp,
    } satisfies Config;
    const transformed = await blurHashPlugin({ collections: ["media"] })(sourceConfig);
    const outcome = await Reflect.apply(getBlurHashHook(transformed, "media"), undefined, [
      {
        data: { mimeType: "image/jpeg" },
        req: { file: { data: input }, payload: { config: { sharp } } },
      },
    ]);

    expect({ normalizationCalls, outcome }).toEqual({ normalizationCalls: 0, outcome: null });
  });

  test("uses the default ten-second generation timeout", async () => {
    vi.useFakeTimers();
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const sharp = createHangingSharp();
    const sourceConfig = {
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      secret: "unit-test-secret",
      sharp,
    } satisfies Config;
    const transformed = await blurHashPlugin({ collections: ["media"] })(sourceConfig);
    let observed: unknown;

    void Reflect.apply(getBlurHashHook(transformed, "media"), undefined, [
      {
        data: { mimeType: "image/jpeg" },
        req: { file: { data: input }, payload: { config: { sharp } } },
      },
    ]).then((outcome: unknown) => {
      observed = outcome;
    });
    await vi.advanceTimersByTimeAsync(9_999);
    const beforeTimeout = observed;
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();

    expect({ afterTimeout: observed, beforeTimeout }).toEqual({
      afterTimeout: null,
      beforeTimeout: undefined,
    });
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
      buildPayloadConfig(
        [
          {
            fields: [{ name: "url", type: "text" }],
            slug: "media",
            upload: true,
          },
          { fields: [], slug: "pages" },
        ],
        [firstPlugin, secondPlugin],
      ),
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
      buildPayloadConfig(
        [{ fields: [], slug: "media", upload: true }],
        [blurHashPlugin({ collections: [], enabled: false })],
      ),
    ).rejects.toMatchObject({
      message:
        "Invalid BlurHash plugin configuration:\n- `collections` must be a non-empty array of upload collection slugs.",
      name: "BlurHashPluginConfigError",
    });
  });

  test("rejects internal or unsafe generated field names", async () => {
    await expect(
      buildPayloadConfig(
        [{ fields: [], slug: "media", upload: true }],
        [
          blurHashPlugin({
            collections: ["media"],
            enabled: false,
            fieldName: "_blur.hash",
          }),
        ],
      ),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- `fieldName` "_blur.hash" must start with a letter and contain only letters, numbers, or underscores.',
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("accepts RGB boundaries and explicit positive safe limits without hidden ceilings", async () => {
    const config = await buildPayloadConfig(
      [{ fields: [], slug: "media", upload: true }],
      [
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
    );

    expect(config.collections[0]?.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "blurHash", type: "text" })]),
    );
  });

  test("rejects a generated field collision hoisted through presentational fields", async () => {
    await expect(
      buildPayloadConfig(
        [
          {
            fields: [
              {
                fields: [
                  {
                    fields: [{ name: "placeholder", type: "text" }],
                    label: "Metadata",
                    type: "collapsible",
                  },
                ],
                type: "row",
              },
            ],
            slug: "media",
            upload: true,
          },
        ],
        [
          blurHashPlugin({
            collections: ["media"],
            enabled: false,
            fieldName: "placeholder",
          }),
        ],
      ),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- Collection "media" already has a top-level data-bearing field named "placeholder".',
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("rejects a generated field collision with a named top-level tab", async () => {
    await expect(
      buildPayloadConfig(
        [
          {
            fields: [
              {
                tabs: [{ fields: [], label: "Placeholder", name: "placeholder" }],
                type: "tabs",
              },
            ],
            slug: "media",
            upload: true,
          },
        ],
        [
          blurHashPlugin({
            collections: ["media"],
            enabled: false,
            fieldName: "placeholder",
          }),
        ],
      ),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- Collection "media" already has a top-level data-bearing field named "placeholder".',
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("rejects a generated field collision with Payload's configured folder field", async () => {
    await expect(
      buildConfig({
        collections: [{ fields: [], folders: true, slug: "media", upload: true }],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        folders: { fieldName: "parentFolder" },
        plugins: [
          blurHashPlugin({
            collections: ["media"],
            enabled: false,
            fieldName: "parentFolder",
          }),
        ],
        secret: "unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message: [
        "Invalid BlurHash plugin configuration:",
        '- Collection "media" reserves the top-level field "parentFolder" for Payload folders.',
      ].join("\n"),
      name: "BlurHashPluginConfigError",
    });
  });

  test("leaves the source collection unchanged", async () => {
    const media = {
      fields: [],
      slug: "media",
      upload: true,
    } satisfies NonNullable<Config["collections"]>[number];

    await buildPayloadConfig([media], [blurHashPlugin({ collections: ["media"], enabled: false })]);

    expect(media.fields).toEqual([]);
  });
});
