// Finding 6: only active super admins count for the last-super-admin rule. A super admin who is
// already in the trash can be deleted for good while another super admin remains.
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let active: Actor;
let trashed: Actor;

beforeAll(async () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    Object.assign(usersCollection, { trash: true });
  }
  context = await createTestPayload({ collections, name: "trash" });
  const { payload } = context;
  active = await seedUser(payload, { email: "active@example.com" });
  trashed = await seedUser(payload, { email: "trashed@example.com", superAdmin: true });
  await payload.update({
    collection: "users",
    data: { deletedAt: new Date().toISOString() },
    id: trashed.id,
  });
});

afterAll(() => context.destroy());

test("a trashed super admin can be deleted permanently while one active super admin remains", async () => {
  const { payload } = context;
  const admin = rest(context, await login(payload, active.email));

  const response = await admin("DELETE", `/users/${trashed.id}?trash=true`);
  expect(response.status).toBe(200);
  expect(
    await payload.findByID({
      collection: "users",
      disableErrors: true,
      id: trashed.id,
      trash: true,
    }),
  ).toBeNull();

  await rejectsWith(
    as(payload, active).delete({ collection: "users", id: active.id }),
    "Forbidden",
  );
  expect(await payload.count({ collection: "users" })).toMatchObject({ totalDocs: 1 });
});

test("a bulk delete without trash ignores a trashed super admin that matches the filter", async () => {
  const { payload } = context;
  const deleter = await seedRole(payload, "users-deleter", {
    collections: { pages: { actions: ["read"] }, users: { actions: ["read", "delete"] } },
  });
  const editor = await seedUser(payload, { email: "deleter@example.com", roles: [deleter] });
  const victim = await seedUser(payload, { email: "victim@example.com" });
  const binned = await seedUser(payload, { email: "binned@example.com", superAdmin: true });
  await payload.update({
    collection: "users",
    data: { deletedAt: new Date().toISOString() },
    id: binned.id,
  });

  const response = await rest(context, await login(payload, editor.email))(
    "DELETE",
    `/users?where[email][in]=${victim.email},${binned.email}`,
  );
  expect(response.status).toBe(200);
  const stored = async (id: number | string) =>
    payload.findByID({ collection: "users", disableErrors: true, id, trash: true });
  expect(await stored(victim.id)).toBeNull();
  expect(await stored(binned.id)).toMatchObject({ superAdmin: true });

  const withTrash = await rest(context, await login(payload, editor.email))(
    "DELETE",
    `/users?where[email][in]=${binned.email}&trash=true`,
  );
  expect(withTrash.status).toBe(400);
  expect(withTrash.json).toMatchObject({ docs: [], errors: [{ id: binned.id }] });
  expect(await stored(binned.id)).toMatchObject({ superAdmin: true });
});
