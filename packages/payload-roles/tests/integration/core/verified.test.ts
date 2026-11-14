// With `auth.verify`, Payload refuses login to a user whose `_verified` is false, and its field
// access lets any signed-in user write it. Unverifying another user is a lockout.
import type { Payload } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, fresh, login, PASSWORD, rest, seedRole } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const verifyingCollections = () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    usersCollection.auth = { verify: true };
  }
  return collections;
};

const seedVerified = async (
  payload: Payload,
  email: string,
  data: { roles?: (number | string)[]; superAdmin?: boolean },
): Promise<Actor> => {
  const created = await payload.create({
    collection: "users",
    data: { _verified: true, email, password: PASSWORD, ...data },
    depth: 0,
  });
  return fresh(payload, created.id);
};

const loginError = async (payload: Payload, email: string) => {
  try {
    await login(payload, email);
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : "unknown";
  }
};

let context: TestPayload;
let users: Record<"covered" | "editor" | "superAdmin" | "target", Actor>;

beforeAll(async () => {
  context = await createTestPayload({ collections: verifyingCollections(), name: "verified" });
  const { payload } = context;
  const superAdmin = await seedVerified(payload, "super@example.com", {});
  const pagesReader = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  const pagesWriter = await seedRole(payload, "pages-writer", {
    collections: { pages: { actions: ["read", "update"] } },
  });
  const usersEditor = await seedRole(payload, "users-editor", {
    collections: { pages: { actions: ["read"] }, users: { actions: ["read", "update"] } },
  });
  users = {
    covered: await seedVerified(payload, "covered@example.com", { roles: [pagesReader] }),
    editor: await seedVerified(payload, "editor@example.com", { roles: [usersEditor] }),
    superAdmin,
    target: await seedVerified(payload, "target@example.com", { roles: [pagesWriter] }),
  };
});

afterAll(() => context.destroy());

test("an editor cannot unverify a super admin or a user they do not cover, one by one or in bulk", async () => {
  const { payload } = context;
  const editor = as(payload, users.editor);
  await rejectsWith(
    editor.update({ collection: "users", data: { _verified: false }, id: users.superAdmin.id }),
    "Forbidden",
  );
  const response = await rest(context, await login(payload, users.editor.email))(
    "PATCH",
    `/users/${users.target.id}`,
    { _verified: false },
  );
  expect(response.status).toBe(403);

  const bulk = await editor.updateMany({
    collection: "users",
    data: { _verified: false },
    where: {
      email: { in: [users.superAdmin.email, users.target.email, users.covered.email] },
    },
  });
  expect(bulk.docs.map((doc) => doc.id)).toEqual([users.covered.id]);
  expect(bulk.errors).toHaveLength(2);
  expect(bulk.errors.map((error) => error.id)).toEqual(
    expect.arrayContaining([users.superAdmin.id, users.target.id]),
  );

  expect(await loginError(payload, users.superAdmin.email)).toBeNull();
  expect(await loginError(payload, users.target.email)).toBeNull();
  expect(await loginError(payload, users.covered.email)).toBe("UnverifiedEmail");
});

test("the stock first-register on a verify-enabled user collection registers and verifies the first user", async () => {
  const empty = await createTestPayload({
    collections: verifyingCollections(),
    name: "verified-first-register",
  });
  try {
    const response = await rest(empty, null)("POST", "/users/first-register", {
      email: "first@example.com",
      password: PASSWORD,
    });
    expect(response.status).toBe(200);
    expect(typeof response.json?.token).toBe("string");
    const stored = await empty.payload.find({ collection: "users", depth: 0 });
    expect(stored.docs).toMatchObject([
      { _verified: true, email: "first@example.com", superAdmin: true },
    ]);
  } finally {
    await empty.destroy();
  }
});
