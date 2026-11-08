// Finding 3: the roles collection belongs to the user collection's members. Users of other
// auth collections get the plugin's base access, which refuses them, before any grant applies.
import { afterAll, beforeAll, expect, test } from "vitest";

import { login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roleId: number | string;
let outsider: ReturnType<typeof rest>;
let member: ReturnType<typeof rest>;

beforeAll(async () => {
  context = await createTestPayload({
    collections: [...fixtureCollections(), { auth: true, fields: [], slug: "customers" }],
    name: "outsiders",
  });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  roleId = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  const rolesReader = await seedRole(payload, "roles-reader", {
    collections: { roles: { actions: ["read"] } },
  });
  const memberUser = await seedUser(payload, { email: "member@example.com", roles: [rolesReader] });
  member = rest(context, await login(payload, memberUser.email));

  await payload.create({
    collection: "customers",
    data: { email: "customer@example.com", password: PASSWORD },
  });
  const session = await payload.login({
    collection: "customers",
    data: { email: "customer@example.com", password: PASSWORD },
  });
  if (!session.token) {
    throw new Error("customer login returned no token");
  }
  outsider = rest(context, session.token);
});

afterAll(() => context.destroy());

test("a user of another auth collection cannot list, change, create or delete roles", async () => {
  const { payload } = context;

  expect((await outsider("GET", "/roles")).status).toBe(403);
  expect((await outsider("GET", "/roles/versions")).status).toBe(403);
  expect((await outsider("PATCH", `/roles/${roleId}`, { permissions: {} })).status).toBe(403);
  expect(
    (await outsider("POST", "/roles", { key: "intruder", name: "intruder", permissions: {} }))
      .status,
  ).toBe(403);
  expect((await outsider("DELETE", `/roles/${roleId}`)).status).toBe(403);

  expect(
    (await payload.findByID({ collection: "roles", depth: 0, id: roleId })).permissions,
  ).toEqual({ collections: { pages: { actions: ["read"] } } });
  expect(
    await payload.count({ collection: "roles", where: { key: { equals: "intruder" } } }),
  ).toMatchObject({ totalDocs: 0 });

  const list = await member("GET", "/roles");
  expect(list.status).toBe(200);
  expect(list.json).toMatchObject({ totalDocs: 2 });
});
