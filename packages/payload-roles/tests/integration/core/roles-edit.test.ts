// Review round 2, finding 2: an editor who cannot cover a role cannot weaken or delete it, so
// they cannot strip a stronger user down to something they cover and then take the account.
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roles: Record<"ops" | "pagesReader" | "pagesWriter", number | string>;
let users: Record<"ops" | "target", Actor>;

const pagesWriterPermissions = {
  collections: { pages: { actions: ["read", "create", "update", "delete"] } },
  globals: {},
};

beforeAll(async () => {
  context = await createTestPayload({ name: "roles-edit" });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  roles = {
    ops: await seedRole(payload, "ops", {
      collections: {
        pages: { actions: ["read"] },
        roles: { actions: ["read", "create", "update", "delete", "readVersions"] },
        users: { actions: ["read", "update"] },
      },
    }),
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    pagesWriter: await seedRole(payload, "pages-writer", pagesWriterPermissions),
  };
  users = {
    ops: await seedUser(payload, { email: "ops@example.com", roles: [roles.ops] }),
    target: await seedUser(payload, { email: "target@example.com", roles: [roles.pagesWriter] }),
  };
});

afterAll(() => context.destroy());

const storedPermissions = async (id: number | string) =>
  (await context.payload.findByID({ collection: "roles", depth: 0, id })).permissions;

test("an editor cannot shrink or delete a role they do not cover to take over its holder", async () => {
  const { payload } = context;
  const ops = rest(context, await login(payload, users.ops.email));
  const changePassword = () =>
    ops("PATCH", `/users/${users.target.id}`, { password: "attacker password" });

  expect((await ops("PATCH", `/users/${users.target.id}`, { roles: [] })).status).toBe(403);
  expect((await changePassword()).status).toBe(403);

  const strip = await ops("PATCH", `/roles/${roles.pagesWriter}`, {
    permissions: { collections: { pages: { actions: ["read"] } } },
  });
  expect(strip.status).toBe(403);
  expect((await ops("PATCH", `/roles/${roles.pagesWriter}`, { name: "renamed" })).status).toBe(403);
  // A bulk write reports each refused document in `errors` instead of failing as a whole.
  const bulkStrip = await ops("PATCH", "/roles?where[key][equals]=pages-writer", {
    permissions: { collections: { pages: { actions: ["read"] } } },
  });
  expect(bulkStrip.status).toBe(400);
  expect(bulkStrip.json).toMatchObject({ docs: [], errors: [{ id: roles.pagesWriter }] });
  expect((await changePassword()).status).toBe(403);

  expect((await ops("DELETE", `/roles/${roles.pagesWriter}`)).status).toBe(403);
  const bulkDelete = await ops("DELETE", "/roles?where[key][equals]=pages-writer");
  expect(bulkDelete.status).toBe(400);
  expect(bulkDelete.json).toMatchObject({ docs: [], errors: [{ id: roles.pagesWriter }] });
  expect((await changePassword()).status).toBe(403);

  expect(await storedPermissions(roles.pagesWriter)).toEqual(pagesWriterPermissions);
  expect(
    (await payload.findByID({ collection: "users", depth: 0, id: users.target.id })).roles,
  ).toEqual([roles.pagesWriter]);
  await expect(login(payload, users.target.email, "attacker password")).rejects.toMatchObject({
    name: "AuthenticationError",
  });
  await login(payload, users.target.email, PASSWORD);
});

test("restoring a role version needs the editor to cover the role as it stands now", async () => {
  const { payload } = context;
  const role = await payload.create({
    collection: "roles",
    data: {
      key: "grown",
      name: "grown",
      permissions: { collections: { pages: { actions: ["read"] } } },
    },
  });
  await payload.update({
    collection: "roles",
    data: { permissions: pagesWriterPermissions },
    id: role.id,
  });
  const { docs } = await payload.findVersions({
    collection: "roles",
    depth: 0,
    where: { parent: { equals: role.id } },
  });
  const readOnly = docs.find((doc) => !JSON.stringify(doc.version.permissions).includes("update"));
  if (!readOnly) {
    throw new Error("no read-only version of the grown role");
  }
  // Payload types version ids as strings, but SQL adapters return numbers.
  const versionId: unknown = readOnly.id;

  await rejectsWith(
    as(payload, users.ops).restoreVersion({ collection: "roles", id: String(versionId) }),
    "Forbidden",
  );
  expect(await storedPermissions(role.id)).toEqual(pagesWriterPermissions);
});

test("an editor can edit, bulk edit and delete roles they fully cover", async () => {
  const { payload } = context;
  const ops = rest(context, await login(payload, users.ops.email));
  const covered = await payload.create({
    collection: "roles",
    data: {
      key: "covered",
      name: "covered",
      permissions: { collections: { pages: { actions: ["read"] } } },
    },
  });

  expect((await ops("PATCH", `/roles/${covered.id}`, { name: "still covered" })).status).toBe(200);
  expect(
    (await ops("PATCH", "/roles?where[key][equals]=covered", { permissions: {} })).status,
  ).toBe(200);
  expect(await storedPermissions(covered.id)).toEqual({ collections: {}, globals: {} });
  expect((await ops("DELETE", `/roles/${covered.id}`)).status).toBe(200);

  await ops("POST", "/roles", { key: "bulk-covered", name: "bulk", permissions: {} });
  expect((await ops("DELETE", "/roles?where[key][equals]=bulk-covered")).status).toBe(200);
  expect(
    await payload.count({
      collection: "roles",
      where: { key: { in: ["covered", "bulk-covered"] } },
    }),
  ).toMatchObject({ totalDocs: 0 });

  expect((await ops("PATCH", `/roles/${roles.pagesReader}`, { description: "read" })).status).toBe(
    200,
  );
});
