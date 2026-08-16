import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type Config } from "payload";
import { describe, expect, test } from "vitest";

import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";

const buildPluginConfig = (media: NonNullable<Config["collections"]>[number]) =>
  buildConfig({
    collections: [media],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins: [blurHashPlugin({ collections: ["media"] } satisfies BlurHashPluginOptions)],
    secret: "unit-test-secret",
  });

describe("blurHashPlugin", () => {
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
