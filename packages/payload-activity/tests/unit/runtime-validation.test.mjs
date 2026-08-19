import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig } from "payload";
import { expect, test } from "vitest";

import { activityPlugin } from "@codlume/payload-activity";

const buildInvalidConfig = (options) =>
  buildConfig({
    collections: [
      { auth: true, fields: [], slug: "users" },
      { fields: [], slug: "posts" },
    ],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins: [activityPlugin(options)],
    secret: "activity-runtime-validation-test-secret",
  });

test("rejects malformed runtime option values together", async () => {
  await expect(
    buildInvalidConfig({
      collections: ["posts", "", 17],
      debug: "yes",
      enabled: 1,
      fieldName: false,
    }),
  ).rejects.toMatchObject({
    message: [
      "Invalid Activity plugin configuration:",
      '- `collections[1]` must be a non-empty string; received "".',
      "- `collections[2]` must be a non-empty string; received 17.",
      "- `fieldName` must be a string; received false.",
      "- `enabled` must be a boolean; received 1.",
      '- `debug` must be a boolean; received "yes".',
    ].join("\n"),
    name: "ActivityPluginConfigError",
  });
});

test("rejects a non-array collections value", async () => {
  await expect(buildInvalidConfig({ collections: "posts" })).rejects.toMatchObject({
    message:
      "Invalid Activity plugin configuration:\n- `collections` must be a non-empty array of collection slugs.",
    name: "ActivityPluginConfigError",
  });
});

test("rejects missing collections from an untyped caller", async () => {
  await expect(buildInvalidConfig({})).rejects.toMatchObject({
    message:
      "Invalid Activity plugin configuration:\n- `collections` must be a non-empty array of collection slugs.",
    name: "ActivityPluginConfigError",
  });
});
