import { afterEach, expect, test } from "vitest";

import { PASSWORD, rest } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload | undefined;

afterEach(async () => {
  await context?.destroy();
  context = undefined;
});

const superAdminCount = async ({ payload }: TestPayload) =>
  (await payload.find({ collection: "users", depth: 0, limit: 0, pagination: false })).docs.filter(
    (doc) => doc.superAdmin === true,
  ).length;

test("the first stored user becomes the super admin and later users do not", async () => {
  context = await createTestPayload({ name: "bootstrap-first" });
  const { payload } = context;

  const first = await payload.create({
    collection: "users",
    data: { email: "first@example.com", password: PASSWORD },
  });
  const second = await payload.create({
    collection: "users",
    data: { email: "second@example.com", password: PASSWORD },
  });

  expect([first.superAdmin, second.superAdmin]).toEqual([true, false]);
  expect(first).not.toHaveProperty("rolesBootstrapClaim");
  expect(await superAdminCount(context)).toBe(1);
});

test("concurrent first registrations over the Local API produce exactly one super admin", async () => {
  context = await createTestPayload({ name: "bootstrap-race" });
  const { payload } = context;

  const results = await Promise.allSettled(
    Array.from({ length: 6 }, (_, index) =>
      payload.create({
        collection: "users",
        data: { email: `racer-${index}@example.com`, password: PASSWORD },
      }),
    ),
  );

  expect(results.some((result) => result.status === "fulfilled")).toBe(true);
  expect(await superAdminCount(context)).toBe(1);
});

test("concurrent REST first registrations produce exactly one super admin", async () => {
  context = await createTestPayload({ name: "bootstrap-rest-race" });
  const anonymous = rest(context, null);

  const responses = await Promise.all(
    Array.from({ length: 4 }, (_, index) =>
      anonymous("POST", "/users/first-register", {
        email: `rest-racer-${index}@example.com`,
        password: PASSWORD,
      }),
    ),
  );

  expect(responses.filter((response) => response.status === 200).length).toBe(1);
  expect(await superAdminCount(context)).toBe(1);
});

test("a first-register body that claims superAdmin or roles is refused even while no user exists", async () => {
  context = await createTestPayload({ name: "bootstrap-rest-privileged" });
  const anonymous = rest(context, null);
  const role = await context.payload.create({
    collection: "roles",
    data: {
      key: "any",
      name: "any",
      permissions: { collections: { pages: { actions: ["read"] } } },
    },
  });

  const [withSuper, withRoles] = await Promise.all([
    anonymous("POST", "/users/first-register", {
      email: "sneaky@example.com",
      password: PASSWORD,
      superAdmin: true,
    }),
    anonymous("POST", "/users/first-register", {
      email: "sneakier@example.com",
      password: PASSWORD,
      roles: [role.id],
    }),
  ]);

  expect([withSuper.status, withRoles.status]).toEqual([403, 403]);
  expect(await context.payload.count({ collection: "users" })).toMatchObject({ totalDocs: 0 });

  const honest = await anonymous("POST", "/users/first-register", {
    email: "honest@example.com",
    password: PASSWORD,
  });
  expect(honest.status).toBe(200);
  expect(await superAdminCount(context)).toBe(1);

  const late = await anonymous("POST", "/users/first-register", {
    email: "late@example.com",
    password: PASSWORD,
  });
  expect(late.status).toBe(403);
});

test("a Local API create with no request is trusted and may set superAdmin", async () => {
  context = await createTestPayload({ name: "bootstrap-trusted" });
  const { payload } = context;
  await payload.create({
    collection: "users",
    data: { email: "first@example.com", password: PASSWORD },
  });

  const admin = await payload.create({
    collection: "users",
    data: { email: "seeded-admin@example.com", password: PASSWORD, superAdmin: true },
  });
  const claimant = await payload.create({
    collection: "users",
    data: { email: "claimant@example.com", password: PASSWORD, rolesBootstrapClaim: "first" },
  });

  expect(admin.superAdmin).toBe(true);
  expect(claimant.superAdmin).toBe(false);
  expect(await superAdminCount(context)).toBe(2);
});
