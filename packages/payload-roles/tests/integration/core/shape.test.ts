// Findings 1 and 4: the privileged fields must arrive in their stored shape. Payload coerces
// `"true"` to `true` and wraps a scalar id into an array after the guards have run, so the
// guards refuse every other shape instead of guessing.
import { createPayloadRequest } from "payload";
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
let roles: Record<"pagesReader" | "pagesWriter" | "usersAdmin", number | string>;
let users: Record<"plain" | "usersEditor", Actor>;

beforeAll(async () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    Object.assign(usersCollection, { access: { create: () => true } });
  }
  context = await createTestPayload({ collections, name: "shape" });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  roles = {
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    pagesWriter: await seedRole(payload, "pages-writer", {
      collections: { pages: { actions: ["read", "create", "update", "delete"] } },
    }),
    usersAdmin: await seedRole(payload, "users-admin", {
      collections: {
        pages: { actions: ["read"] },
        users: { actions: ["read", "create", "update", "delete"] },
      },
    }),
  };
  users = {
    plain: await seedUser(payload, { email: "plain@example.com", roles: [roles.pagesReader] }),
    usersEditor: await seedUser(payload, {
      email: "users-editor@example.com",
      roles: [roles.usersAdmin],
    }),
  };
});

afterAll(() => context.destroy());

test("a roles value that is not an array of ids is refused instead of being wrapped and stored", async () => {
  const editor = as(context.payload, users.usersEditor);
  const editorRest = rest(context, await login(context.payload, users.usersEditor.email));

  const scalar = await editorRest("PATCH", `/users/${users.plain.id}`, {
    roles: roles.pagesWriter,
  });
  expect(scalar.status).toBe(400);
  expect((await fresh(context.payload, users.plain.id)).roles).toEqual([roles.pagesReader]);

  const created = await editorRest("POST", "/users", {
    email: "scalar@example.com",
    password: PASSWORD,
    roles: String(roles.pagesWriter),
  });
  expect(created.status).toBe(400);
  expect(
    await context.payload.count({
      collection: "users",
      where: { email: { equals: "scalar@example.com" } },
    }),
  ).toMatchObject({ totalDocs: 0 });

  expect(
    await validationPaths(
      editor.update({ collection: "users", data: { roles: 5 }, id: users.plain.id }),
    ),
  ).toEqual(["roles"]);
  expect(
    await validationPaths(
      editor.update({
        collection: "users",
        data: { roles: [{ id: roles.pagesReader }] },
        id: users.plain.id,
      }),
    ),
  ).toEqual(["roles"]);
  const bulk = await editor.updateMany({
    collection: "users",
    data: { roles: "none" },
    where: { email: { equals: users.plain.email } },
  });
  expect(bulk.docs).toEqual([]);
  expect(bulk.errors).toHaveLength(1);
  expect((await fresh(context.payload, users.plain.id)).roles).toEqual([roles.pagesReader]);
});

test("a superAdmin value that is not a boolean is refused, including on a REST-origin create with access overridden", async () => {
  const editor = as(context.payload, users.usersEditor);
  expect(
    await validationPaths(
      editor.update({ collection: "users", data: { superAdmin: "true" }, id: users.plain.id }),
    ),
  ).toEqual(["superAdmin"]);
  expect((await fresh(context.payload, users.plain.id)).superAdmin).toBe(false);

  // Payload's first-register calls `create({ overrideAccess: true, req })` with the anonymous
  // HTTP request. A late racer reaches that call after the first user exists.
  const restOrigin = () =>
    createPayloadRequest({
      config: context.config,
      payloadInstanceCacheKey: context.key,
      request: new Request("http://localhost/api/users/first-register", { method: "POST" }),
    });
  await rejectsWith(
    context.payload.create({
      collection: "users",
      data: { email: "racer-bool@example.com", password: PASSWORD, superAdmin: true },
      overrideAccess: true,
      req: await restOrigin(),
    }),
    "Forbidden",
  );
  await rejectsWith(
    context.payload.create({
      collection: "users",
      data: { email: "racer-string@example.com", password: PASSWORD, superAdmin: "true" },
      overrideAccess: true,
      req: await restOrigin(),
    }),
    "ValidationError",
  );
  expect(
    await context.payload.count({
      collection: "users",
      where: { email: { like: "racer-" } },
    }),
  ).toMatchObject({ totalDocs: 0 });
});

test("the stock first-register body with superAdmin false and no roles still registers the first user", async () => {
  const empty = await createTestPayload({ name: "shape-first-register" });
  try {
    const response = await rest(empty, null)("POST", "/users/first-register", {
      email: "first@example.com",
      password: PASSWORD,
      roles: [],
      superAdmin: false,
    });
    expect(response.status).toBe(200);
    const stored = await empty.payload.find({ collection: "users", depth: 0 });
    expect(stored.docs).toMatchObject([{ email: "first@example.com", superAdmin: true }]);
  } finally {
    await empty.destroy();
  }
});
