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
    globals: [{ fields: [], slug: "site-settings" }],
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

test("rejects malformed runtime global target values together", async () => {
  await expect(
    buildInvalidConfig({
      collections: ["posts"],
      globals: ["site-settings", "", 17],
    }),
  ).rejects.toMatchObject({
    message: [
      "Invalid Activity plugin configuration:",
      '- `globals[1]` must be a non-empty string; received "".',
      "- `globals[2]` must be a non-empty string; received 17.",
    ].join("\n"),
    name: "ActivityPluginConfigError",
  });
});

test("rejects an empty globals array even when a collection is configured", async () => {
  await expect(buildInvalidConfig({ collections: ["posts"], globals: [] })).rejects.toMatchObject({
    message:
      "Invalid Activity plugin configuration:\n- `globals` must be a non-empty array of global slugs.",
    name: "ActivityPluginConfigError",
  });
});

test("rejects missing targets from an untyped caller", async () => {
  await expect(buildInvalidConfig({})).rejects.toMatchObject({
    message:
      "Invalid Activity plugin configuration:\n- Configure at least one target with `collections` or `globals`.",
    name: "ActivityPluginConfigError",
  });
});
