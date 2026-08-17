import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { s3Storage } from "@payloadcms/storage-s3";
import { buildConfig } from "payload";
import { expect, test } from "vitest";

import { blurHashPlugin } from "@codlume/payload-blurhash";

test("the installed plugin enforces its configuration contract", async () => {
  await expect(
    buildConfig({
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [blurHashPlugin({ collections: [], enabled: false })],
      secret: "compatibility-test-secret",
    }),
  ).rejects.toMatchObject({
    message:
      "Invalid BlurHash plugin configuration:\n- `collections` must be a non-empty array of upload collection slugs.",
    name: "BlurHashPluginConfigError",
  });
});

test("the installed plugin reserves the official S3 prefix field", async () => {
  await expect(
    buildConfig({
      collections: [{ fields: [], slug: "media", upload: true }],
      db: sqliteAdapter({ client: { url: ":memory:" } }),
      plugins: [
        blurHashPlugin({
          collections: ["media"],
          enabled: false,
          fieldName: "prefix",
        }),
        s3Storage({
          bucket: "payload-blurhash",
          collections: { media: { prefix: "compatibility" } },
          config: {
            credentials: { accessKeyId: "test", secretAccessKey: "test" },
            endpoint: "http://localstack:4566",
            forcePathStyle: true,
            region: "us-east-1",
          },
        }),
      ],
      secret: "compatibility-test-secret",
    }),
  ).rejects.toMatchObject({
    message: [
      "Invalid BlurHash plugin configuration:",
      '- `fieldName` "prefix" is reserved by Payload; choose a plugin-owned field name.',
    ].join("\n"),
    name: "BlurHashPluginConfigError",
  });
});
