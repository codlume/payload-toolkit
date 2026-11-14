// An app `beforeOperation` hook may hand Payload a new request. The plugin recorded the
// operation under the request it was called with, so the document hooks find no record. The
// last-super-admin rule must still hold across the documents of one bulk.
import { createLocalReq, type CollectionBeforeOperationHook } from "payload";
import { afterEach, beforeEach, expect, test } from "vitest";

import { login, rest, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const swapRequest: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== "delete" && operation !== "update") {
    return args;
  }
  return { ...args, req: await createLocalReq(req.user ? { user: req.user } : {}, req.payload) };
};

let context: TestPayload;

beforeEach(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, { hooks: { beforeOperation: [swapRequest] } })
        : collection,
    ),
    name: "swapped-request",
  });
  await seedUser(context.payload, { email: "first@example.com", superAdmin: true });
  await seedUser(context.payload, { email: "second@example.com", superAdmin: true });
  await seedUser(context.payload, { email: "third@example.com", superAdmin: true });
});

afterEach(() => context.destroy());

const activeSuperAdmins = async () =>
  (
    await context.payload.count({
      collection: "users",
      where: { superAdmin: { equals: true } },
    })
  ).totalDocs;

const asFirst = async () => rest(context, await login(context.payload, "first@example.com"));

test("a bulk delete of every super admin leaves one when an app hook swaps the request", async () => {
  const response = await (await asFirst())("DELETE", "/users?where[superAdmin][equals]=true");

  expect(await activeSuperAdmins()).toBe(1);
  expect(response.json).toMatchObject({ errors: [{ message: expect.any(String) }] });
});

test("a bulk demotion of every super admin leaves one when an app hook swaps the request", async () => {
  const response = await (
    await asFirst()
  )("PATCH", "/users?where[superAdmin][equals]=true", { superAdmin: false });

  expect(await activeSuperAdmins()).toBe(1);
  expect(response.json).toMatchObject({ errors: [{ message: expect.any(String) }] });
});
