import { sqliteAdapter } from "@payloadcms/db-sqlite";
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
