// Payload's sanitizer and later plugins can add hooks around the roles plugin's own after it
// runs. Startup puts the plugin's hooks back at both ends, so its guards always judge the final
// data and its opener always runs first, and refuses to start if one of them was removed.
import type { CollectionConfig, Config, Plugin } from "payload";
import { afterEach, expect, test } from "vitest";

import { as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload | undefined;

afterEach(async () => {
  await context?.destroy();
  context = undefined;
});

const lastPlugin = (fn: Plugin): Plugin => {
  fn.order = Number.MAX_SAFE_INTEGER;
  return fn;
};

const editUsers = (edit: (users: CollectionConfig) => void) =>
  lastPlugin((config: Config) => {
    const users = config.collections?.find((collection) => collection.slug === "users");
    if (users) {
      edit(users);
    }
    return config;
  });

const seedEditor = async (payload: TestPayload["payload"]) => {
  await seedUser(payload, { email: "root@example.test", superAdmin: true });
  const role = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update"] } },
  });
  return seedUser(payload, { email: "editor@example.test", roles: [role] });
};

const stored = (
  payload: TestPayload["payload"],
  collection: "pages" | "users",
  id: number | string,
) => payload.db.findOne({ collection, where: { id: { equals: id } } });

test("orderable users and managed collections start, order their documents, and keep the guards", async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users" || collection.slug === "pages"
        ? Object.assign(collection, { orderable: true })
        : collection,
    ),
    name: "hook-order-orderable",
  });
  const { payload } = context;
  await seedEditor(payload);
  const target = await seedUser(payload, { email: "target@example.test", superAdmin: true });
  const page = await payload.create({ collection: "pages", data: { title: "Home" } });

  expect(await stored(payload, "users", target.id)).toMatchObject({ _order: expect.any(String) });
  expect(await stored(payload, "pages", page.id)).toMatchObject({ _order: expect.any(String) });
  const token = await login(payload, "editor@example.test");
  const response = await rest(context, token)("PATCH", `/users/${target.id}`, {
    password: "takeover-attempt-password",
  });
  expect(response.status).toBe(403);
});

test("a later plugin's hook that grants super admin on every write is judged by the guard", async () => {
  context = await createTestPayload({
    name: "hook-order-late-append",
    plugins: [
      editUsers((users) => {
        users.hooks = {
          ...users.hooks,
          beforeChange: [
            ...(users.hooks?.beforeChange ?? []),
            ({ data, operation }) =>
              operation === "update" ? { ...data, superAdmin: true } : data,
          ],
        };
      }),
    ],
  });
  const { payload } = context;
  const editor = await seedEditor(payload);

  await rejectsWith(
    as(payload, editor).update({
      collection: "users",
      data: { email: "editor-renamed@example.test" },
      id: editor.id,
    }),
    "Forbidden",
  );
  expect(await stored(payload, "users", editor.id)).toMatchObject({
    email: "editor@example.test",
    superAdmin: false,
  });

  await payload.update({ collection: "users", data: {}, id: editor.id });
  expect(await stored(payload, "users", editor.id)).toMatchObject({ superAdmin: true });
});

test("a later plugin's awaiting beforeOperation hook cannot displace the opener", async () => {
  context = await createTestPayload({
    name: "hook-order-late-prepend",
    plugins: [
      editUsers((users) => {
        users.hooks = {
          ...users.hooks,
          beforeOperation: [
            async () => {
              await new Promise((resolve) => setTimeout(resolve, 1));
            },
            ...(users.hooks?.beforeOperation ?? []),
          ],
        };
      }),
    ],
  });
  const { payload } = context;
  const editor = await seedEditor(payload);

  await payload.update({ collection: "users", data: { superAdmin: true }, id: editor.id });
  expect(await stored(payload, "users", editor.id)).toMatchObject({ superAdmin: true });
  await payload.update({ collection: "users", data: { superAdmin: false }, id: editor.id });

  await rejectsWith(
    as(payload, editor).update({ collection: "users", data: { superAdmin: true }, id: editor.id }),
    "Forbidden",
  );
  expect(await stored(payload, "users", editor.id)).toMatchObject({ superAdmin: false });
});

test("a later plugin that removes the plugin's own guard fails startup", async () => {
  await expect(
    createTestPayload({
      name: "hook-order-removed",
      plugins: [
        editUsers((users) => {
          users.hooks = { ...users.hooks, beforeChange: [] };
        }),
      ],
    }),
  ).rejects.toThrow(/collections:users.*beforeChange/u);
});
