// Finding 8: `enabled: false` keeps the schema and turns every plugin check off, field access
// included. What the app lets a user write is stored as sent.
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, defaultRolesOptions, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roleId: number | string;
let plain: Actor;
let other: Actor;

beforeAll(async () => {
  context = await createTestPayload({
    name: "disabled",
    roles: { ...defaultRolesOptions(), enabled: false },
  });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  roleId = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  plain = await seedUser(payload, { email: "plain@example.com" });
  other = await seedUser(payload, { email: "other@example.com" });
});

afterAll(() => context.destroy());

test("in disabled mode a role assignment by any signed-in user is stored, not silently stripped", async () => {
  const { payload } = context;
  const editor = as(payload, plain);

  await editor.update({ collection: "users", data: { roles: [roleId] }, id: other.id });
  expect((await fresh(payload, other.id)).roles).toEqual([roleId]);

  await editor.update({ collection: "users", data: { superAdmin: true }, id: other.id });
  expect((await fresh(payload, other.id)).superAdmin).toBe(true);

  expect((await editor.find({ collection: "pages" })).totalDocs).toBe(0);
  expect(context.logs).toContainEqual(
    expect.objectContaining({ event: "enforcement_disabled", plugin: "roles" }),
  );
});
