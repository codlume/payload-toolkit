import { afterAll, beforeAll, expect, test } from "vitest";

import {
  type Actor,
  as,
  fresh,
  login,
  PASSWORD,
  rest,
  seedRole,
  seedUser,
} from "../../helpers/actors.ts";
import { rejectsWith, validationPaths } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roles: Record<"pagesReader" | "pagesWriter" | "rolesAdmin" | "usersAdmin", number | string>;
let users: Record<
  "noRoles" | "plain" | "rolesEditor" | "superAdmin" | "usersEditor" | "writer",
  Actor
>;

beforeAll(async () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    Object.assign(usersCollection, { access: { create: () => true }, disableDuplicate: false });
  }
  context = await createTestPayload({ collections, name: "escalation" });
  const { payload } = context;
  const superAdmin = await seedUser(payload, { email: "super@example.com" });
  roles = {
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    pagesWriter: await seedRole(payload, "pages-writer", {
      collections: {
        pages: {
          actions: [
            "read",
            "create",
            "update",
            "delete",
            "publish",
            "unpublish",
            "trash",
            "readVersions",
          ],
        },
      },
    }),
    rolesAdmin: await seedRole(payload, "roles-admin", {
      collections: {
        pages: { actions: ["read"] },
        roles: { actions: ["read", "create", "update", "delete"] },
      },
    }),
    usersAdmin: await seedRole(payload, "users-admin", {
      collections: {
        pages: { actions: ["read"] },
        roles: { actions: ["read"] },
        users: { actions: ["read", "create", "update", "delete"] },
      },
    }),
  };
  users = {
    noRoles: await seedUser(payload, { email: "no-roles@example.com" }),
    plain: await seedUser(payload, { email: "plain@example.com", roles: [roles.pagesReader] }),
    rolesEditor: await seedUser(payload, {
      email: "roles-editor@example.com",
      roles: [roles.rolesAdmin],
    }),
    superAdmin,
    usersEditor: await seedUser(payload, {
      email: "users-editor@example.com",
      roles: [roles.usersAdmin],
    }),
    writer: await seedUser(payload, { email: "writer@example.com", roles: [roles.pagesWriter] }),
  };
});

afterAll(() => context.destroy());

test("an editor cannot create a role with an action they lack, over the Local API and REST", async () => {
  const editor = as(context.payload, users.rolesEditor);
  const paths = await validationPaths(
    editor.create({
      collection: "roles",
      data: {
        key: "too-much",
        name: "too much",
        permissions: { collections: { pages: { actions: ["update"] } } },
      },
    }),
  );
  expect(paths).toEqual(["permissions"]);

  const response = await rest(context, await login(context.payload, users.rolesEditor.email))(
    "POST",
    "/roles",
    {
      key: "too-much-rest",
      name: "x",
      permissions: { collections: { pages: { actions: ["update"] } } },
    },
  );
  expect(response.status).toBe(400);
  expect(JSON.stringify(response.json)).toContain("permissions.collections.pages.actions");
});

test("an editor can create a role within their own capabilities, stored in canonical form", async () => {
  const created = await as(context.payload, users.rolesEditor).create({
    collection: "roles",
    data: {
      key: "within",
      name: "within",
      permissions: {
        collections: { pages: { actions: ["read", "read"] }, roles: { actions: ["read"] } },
      },
    },
  });

  const stored = await context.payload.findByID({ collection: "roles", depth: 0, id: created.id });
  expect(stored.permissions).toEqual({
    collections: { pages: { actions: ["read"] }, roles: { actions: ["read"] } },
    globals: {},
  });
});

test("an editor cannot add an action they lack to an existing role, including their own", async () => {
  const editor = as(context.payload, users.rolesEditor);

  await validationPaths(
    editor.update({
      collection: "roles",
      data: { permissions: { collections: { pages: { actions: ["read", "update"] } } } },
      id: roles.rolesAdmin,
    }),
  );
  await validationPaths(
    editor.update({
      collection: "roles",
      data: { permissions: { collections: { users: { actions: ["read"] } } } },
      id: roles.pagesReader,
    }),
  );
  expect(
    await validationPaths(
      editor.update({ collection: "roles", data: { key: "renamed" }, id: roles.pagesReader }),
    ),
  ).toEqual(["key"]);
});

test("a super admin still gets shape errors: publish without update, unknown slugs, inapplicable actions", async () => {
  const refused: unknown = await as(context.payload, users.superAdmin)
    .create({
      collection: "roles",
      data: {
        key: "shape",
        name: "shape",
        permissions: {
          collections: {
            pages: { actions: ["publish"] },
            nothing: { actions: ["read"] },
            posts: { actions: ["publish"] },
          },
        },
      },
    })
    .catch((caught: unknown) => caught);
  expect(refused).toMatchObject({
    data: { errors: [{ path: "permissions" }] },
    name: "ValidationError",
  });
  for (const issue of [
    'permissions.collections.nothing.actions: "collections:nothing" is not managed',
    'permissions.collections.pages.actions: Action "publish" requires "update"',
    'permissions.collections.posts.actions: Action "publish" does not apply',
  ]) {
    expect(refused).toMatchObject({
      data: { errors: [{ message: expect.stringContaining(issue) }] },
    });
  }
});

test("a user cannot assign themselves a role", async () => {
  const editor = as(context.payload, users.usersEditor);
  await rejectsWith(
    editor.update({
      collection: "users",
      data: { roles: [roles.usersAdmin, roles.pagesReader] },
      id: users.usersEditor.id,
    }),
    "Forbidden",
  );

  const response = await rest(context, await login(context.payload, users.usersEditor.email))(
    "PATCH",
    `/users/${users.usersEditor.id}`,
    { roles: [roles.usersAdmin, roles.pagesReader] },
  );
  expect(response.status).toBe(403);
  expect((await fresh(context.payload, users.usersEditor.id)).roles).toEqual([roles.usersAdmin]);
});

test("a user cannot set superAdmin on anyone, including a new user", async () => {
  const editor = as(context.payload, users.usersEditor);
  await rejectsWith(
    editor.update({ collection: "users", data: { superAdmin: true }, id: users.plain.id }),
    "Forbidden",
  );
  await rejectsWith(
    editor.create({
      collection: "users",
      data: { email: "minted@example.com", password: PASSWORD, superAdmin: true },
    }),
    "Forbidden",
  );

  const response = await rest(context, await login(context.payload, users.usersEditor.email))(
    "PATCH",
    `/users/${users.plain.id}`,
    { superAdmin: true },
  );
  expect(response.status).toBe(403);
  expect((await fresh(context.payload, users.plain.id)).superAdmin).toBe(false);
});

test("the last super admin cannot be demoted or deleted, even by themselves", async () => {
  const admin = as(context.payload, users.superAdmin);
  await rejectsWith(
    admin.update({ collection: "users", data: { superAdmin: false }, id: users.superAdmin.id }),
    "Forbidden",
  );
  await rejectsWith(admin.delete({ collection: "users", id: users.superAdmin.id }), "Forbidden");

  const second = await seedUser(context.payload, {
    email: "second-admin@example.com",
    superAdmin: true,
  });
  const demoted = await as(context.payload, second).update({
    collection: "users",
    data: { superAdmin: false },
    id: users.superAdmin.id,
  });
  expect(demoted.superAdmin).toBe(false);
  await context.payload.update({
    collection: "users",
    data: { superAdmin: true },
    id: users.superAdmin.id,
  });
  await context.payload.delete({ collection: "users", id: second.id });
});

test("a users-creator cannot create a user holding roles beyond their own", async () => {
  const editor = as(context.payload, users.usersEditor);
  await rejectsWith(
    editor.create({
      collection: "users",
      data: { email: "escalated@example.com", password: PASSWORD, roles: [roles.pagesWriter] },
    }),
    "Forbidden",
  );

  const created = await editor.create({
    collection: "users",
    data: { email: "covered@example.com", password: PASSWORD, roles: [roles.pagesReader] },
  });
  expect((await fresh(context.payload, created.id)).roles).toEqual([roles.pagesReader]);
});

test("a users-editor cannot change credentials of a super admin or of a more capable user", async () => {
  const editor = as(context.payload, users.usersEditor);
  await rejectsWith(
    editor.update({
      collection: "users",
      data: { password: "new password 123" },
      id: users.superAdmin.id,
    }),
    "Forbidden",
  );
  await rejectsWith(
    editor.update({
      collection: "users",
      data: { email: "writer-stolen@example.com" },
      id: users.writer.id,
    }),
    "Forbidden",
  );

  await editor.update({
    collection: "users",
    data: { email: users.plain.email },
    id: users.plain.id,
  });
  await editor.update({
    collection: "users",
    data: { password: "reset by editor" },
    id: users.plain.id,
  });
  expect(await login(context.payload, users.plain.email, "reset by editor")).toBeTypeOf("string");
  await context.payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: users.plain.id,
  });
});

test("a user may change their own credentials but not their own roles", async () => {
  const plain = as(context.payload, users.plain);
  await plain.update({
    collection: "users",
    data: { password: "my new password" },
    id: users.plain.id,
  });
  expect(await login(context.payload, users.plain.email, "my new password")).toBeTypeOf("string");
  await context.payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: users.plain.id,
  });

  await plain.update({
    collection: "users",
    data: { roles: [roles.pagesReader] },
    id: users.plain.id,
  });
  await rejectsWith(
    plain.update({ collection: "users", data: { roles: [] }, id: users.plain.id }),
    "Forbidden",
  );
});

test("a bulk update is judged one user at a time, so only the users the editor may change go through", async () => {
  const editor = as(context.payload, users.usersEditor);
  const promotion = await editor.updateMany({
    collection: "users",
    data: { superAdmin: true },
    where: { email: { equals: users.plain.email } },
  });
  expect(promotion.docs).toEqual([]);
  expect(promotion.errors).toHaveLength(1);
  expect((await fresh(context.payload, users.plain.id)).superAdmin).toBe(false);

  const reset = await editor.updateMany({
    collection: "users",
    data: { password: "mass reset" },
    where: { email: { in: [users.plain.email, users.writer.email] } },
  });
  expect(reset.docs.map((doc) => doc.email)).toEqual([users.plain.email]);
  expect(reset.errors).toHaveLength(1);
  expect(await login(context.payload, users.plain.email, "mass reset")).toBeTypeOf("string");
  await login(context.payload, users.writer.email);
  await context.payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: users.plain.id,
  });
});

test("a users-editor can delete only users they cover", async () => {
  const editor = as(context.payload, users.usersEditor);
  await rejectsWith(editor.delete({ collection: "users", id: users.writer.id }), "Forbidden");
  await rejectsWith(editor.delete({ collection: "users", id: users.superAdmin.id }), "Forbidden");

  await editor.delete({ collection: "users", id: users.noRoles.id });
  await rejectsWith(
    context.payload.findByID({ collection: "users", id: users.noRoles.id }),
    "NotFound",
  );
});

test("duplicating a user or a role runs the same checks against the merged document", async () => {
  await rejectsWith(
    as(context.payload, users.usersEditor).duplicate({
      collection: "users",
      data: { email: "writer-copy@example.com", password: PASSWORD },
      id: users.writer.id,
    }),
    "Forbidden",
  );
  // Payload's field access drops the copied `superAdmin` before the guard sees it.
  const copy = await as(context.payload, users.usersEditor).duplicate({
    collection: "users",
    data: { email: "super-copy@example.com", password: PASSWORD },
    id: users.superAdmin.id,
  });
  expect((await fresh(context.payload, copy.id)).superAdmin).toBe(false);
  const paths = await validationPaths(
    as(context.payload, users.rolesEditor).duplicate({
      collection: "roles",
      id: roles.pagesWriter,
    }),
  );
  expect(paths).toEqual(["permissions"]);
});

test("anonymous signup on a public create keeps working but cannot carry roles or superAdmin", async () => {
  const anonymous = rest(context, null);

  expect(
    (
      await anonymous("POST", "/users", {
        email: "a@example.com",
        password: PASSWORD,
        roles: [roles.pagesReader],
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await anonymous("POST", "/users", {
        email: "b@example.com",
        password: PASSWORD,
        superAdmin: true,
      })
    ).status,
  ).toBe(403);

  const honest = await anonymous("POST", "/users", { email: "c@example.com", password: PASSWORD });
  expect(honest.status).toBe(201);
  const stored = await context.payload.find({
    collection: "users",
    depth: 0,
    where: { email: { equals: "c@example.com" } },
  });
  expect(stored.docs[0]).toMatchObject({ roles: [], superAdmin: false });
});
