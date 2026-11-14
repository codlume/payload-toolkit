// A role can hold permissions the plugin refuses today: a trusted seed is not validated, and a
// config change can retire a collection or an action. Its other fields must stay editable.
import type { Plugin } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { validationPaths } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

const stale = {
  collections: {
    pages: { actions: ["read", "publish"] },
    posts: { actions: ["trash"] },
    retired: { actions: ["read"] },
  },
};

const publishOnly = { collections: { pages: { actions: ["publish"] } } };

/** The stored value with its keys in another order, as a JSON column may return it. */
const reordered = {
  collections: {
    retired: { actions: ["read"] },
    posts: { actions: ["trash"] },
    pages: { actions: ["read", "publish"] },
  },
};

/** The plugin creates the roles collection, so a later plugin stands in for its app hook. */
const rewritePermissions: Plugin = (incoming) => {
  const roles = incoming.collections?.find((collection) => collection.slug === "roles");
  if (roles) {
    roles.hooks = {
      ...roles.hooks,
      beforeChange: [
        ({ data }) =>
          data.description === "rewrite"
            ? { ...data, permissions: publishOnly }
            : data.description === "reorder"
              ? { ...data, permissions: reordered }
              : data,
        ...(roles.hooks?.beforeChange ?? []),
      ],
    };
  }
  return incoming;
};
rewritePermissions.order = Number.MAX_SAFE_INTEGER;

let context: TestPayload;
let superAdmin: Actor;
let role: number | string;

beforeAll(async () => {
  context = await createTestPayload({ name: "stale-permissions", plugins: [rewritePermissions] });
  superAdmin = await seedUser(context.payload, { email: "super@example.com" });
  role = await seedRole(context.payload, "seeded", stale);
});

afterAll(() => context.destroy());

const stored = async () =>
  context.payload.db.findOne({ collection: "roles", where: { id: { equals: role } } });

test("a role with invalid stored permissions can be renamed and bulk edited, and keeps them", async () => {
  const { payload } = context;

  const renamed = await as(payload, superAdmin).update({
    collection: "roles",
    data: { name: "renamed" },
    id: role,
  });
  const bulk = await rest(context, await login(payload, superAdmin.email))(
    "PATCH",
    "/roles?where[key][equals]=seeded",
    { description: "described" },
  );

  expect(renamed.name).toBe("renamed");
  expect(bulk).toMatchObject({ json: { errors: [] }, status: 200 });
  expect(await stored()).toMatchObject({
    description: "described",
    name: "renamed",
    permissions: stale,
  });
});

test("stored permissions that arrive in another key order still count as unchanged", async () => {
  const edited = await as(context.payload, superAdmin).update({
    collection: "roles",
    data: { description: "reorder" },
    id: role,
  });

  expect(edited.description).toBe("reorder");
  expect(await stored()).toMatchObject({ permissions: stale });
});

test("sending the invalid stored permissions back is still refused at the field", async () => {
  const paths = await validationPaths(
    as(context.payload, superAdmin).update({
      collection: "roles",
      data: { name: "resent", permissions: stale },
      id: role,
    }),
  );

  expect(paths).toEqual(["permissions"]);
  expect(await stored()).toMatchObject({ permissions: stale });
  expect(await stored()).not.toMatchObject({ name: "resent" });
});

test("an app hook that rewrites permissions to an invalid value is still refused at the field", async () => {
  const paths = await validationPaths(
    as(context.payload, superAdmin).update({
      collection: "roles",
      data: { description: "rewrite" },
      id: role,
    }),
  );

  expect(paths).toEqual(["permissions"]);
  expect(await stored()).toMatchObject({ permissions: stale });
  expect(await stored()).not.toMatchObject({ description: "rewrite" });
});
