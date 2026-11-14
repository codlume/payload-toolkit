import type { Plugin } from "payload";
import { afterEach, expect, test } from "vitest";

import { RolesPluginConfigError, rolesPlugin } from "@codlume/payload-roles";

import { as, seedUser } from "../../helpers/actors.ts";
import { createTestConfig, createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload | undefined;

afterEach(async () => {
  await context?.destroy();
  context = undefined;
});

const lastPlugin = (fn: Plugin): Plugin => {
  fn.order = Number.MAX_SAFE_INTEGER;
  return fn;
};

test("the plugin identifies itself and asks to run after plugins without an order", () => {
  const plugin = rolesPlugin({ collections: ["pages"] });
  expect({ order: plugin.order, slug: plugin.slug }).toEqual({
    order: Number.MAX_SAFE_INTEGER,
    slug: "@codlume/payload-roles",
  });
});

test("configuration problems are collected into one error", async () => {
  await expect(
    createTestConfig(
      {
        name: "startup-problems",
        roles: {
          collections: ["pages", "pages", "missing", "payload-preferences"],
          globals: ["nope"],
          rolesField: "email",
          userCollection: "posts",
        },
      },
      [],
    ),
  ).rejects.toSatisfy(
    (error: unknown) =>
      error instanceof RolesPluginConfigError &&
      [
        'duplicate slug "pages"',
        '"missing" does not exist',
        '"nope" does not exist',
        "must be auth-enabled",
      ].every((fragment) => error.message.includes(fragment)),
  );
});

test("registering the plugin twice is refused", async () => {
  await expect(
    createTestConfig(
      { name: "startup-twice", plugins: [rolesPlugin({ collections: ["pages"] })] },
      [],
    ),
  ).rejects.toThrow(/only once/u);
});

test("a later plugin that changes a managed collection's drafts flag fails startup", async () => {
  await expect(
    createTestPayload({
      name: "startup-drift",
      plugins: [
        lastPlugin((config) => {
          const posts = config.collections?.find((collection) => collection.slug === "posts");
          if (posts) {
            posts.versions = { drafts: true };
          }
          return config;
        }),
      ],
    }),
  ).rejects.toThrow(/drafts/u);
});

test("disabled mode keeps the schema, warns, and lets app access decide alone", async () => {
  context = await createTestPayload({
    name: "startup-disabled",
    roles: { collections: ["pages"], enabled: false },
  });
  const { payload } = context;
  const first = await seedUser(payload, { email: "first@example.com" });
  const nobody = await seedUser(payload, { email: "nobody@example.com" });
  await payload.create({ collection: "pages", data: { title: "Home" } });

  expect(context.logs).toContainEqual(expect.objectContaining({ event: "enforcement_disabled" }));
  expect(first.superAdmin).toBe(true);
  expect(payload.collections.roles).toBeDefined();
  expect((await as(payload, nobody).find({ collection: "pages" })).totalDocs).toBe(1);
});
