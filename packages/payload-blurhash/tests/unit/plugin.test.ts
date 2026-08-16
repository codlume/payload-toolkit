import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type Config } from "payload";
import { describe, expect, test } from "vitest";

import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";

describe("blurHashPlugin", () => {
  test("adds one stored nullable text field to a configured upload collection", async () => {
    const options = {
      collections: ["media"],
    } satisfies BlurHashPluginOptions;
    const media = {
      fields: [],
      slug: "media",
      upload: true,
    } satisfies NonNullable<Config["collections"]>[number];
    const config = await buildConfig({
      collections: [media],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [blurHashPlugin(options)],
      secret: "unit-test-secret",
    });

    const field = config.collections[0]?.fields.find(
      (candidate) => "name" in candidate && candidate.name === "blurHash",
    );

    expect({
      field,
      isLocalized: field && "localized" in field ? field.localized : false,
      originalFields: media.fields,
    }).toMatchObject({
      field: {
        name: "blurHash",
        required: false,
        type: "text",
        virtual: false,
      },
      isLocalized: false,
      originalFields: [],
    });
  });
});
