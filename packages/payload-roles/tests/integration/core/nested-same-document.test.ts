// An app `beforeChange` hook starts a trusted write of the same document for every document of a
// bulk. Each nested write opens a record of its own, so the last-super-admin rule must still count
// the bulk's removals across all of its documents.
import { type CollectionBeforeChangeHook, updateByIDOperation } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { login, rest, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const touched = new Set<unknown>();

const touchSameDocument: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const users = req.payload.collections.users;
  if (users && originalDoc?.id !== undefined && !touched.has(originalDoc.id)) {
    touched.add(originalDoc.id);
    await updateByIDOperation({
      collection: users,
      data: {},
      depth: 0,
      disableTransaction: true,
      id: originalDoc.id,
      overrideAccess: true,
      req,
    });
  }
  return data;
};

let context: TestPayload;

beforeAll(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, { hooks: { beforeChange: [touchSameDocument] } })
        : collection,
    ),
    name: "nested-same-document",
  });
  await seedUser(context.payload, { email: "first@example.com", superAdmin: true });
  await seedUser(context.payload, { email: "second@example.com", superAdmin: true });
  await seedUser(context.payload, { email: "third@example.com", superAdmin: true });
});

afterAll(() => context.destroy());

test("a bulk demotion of every super admin leaves one", async () => {
  const call = rest(context, await login(context.payload, "first@example.com"));
  touched.clear();

  await call("PATCH", "/users?where[superAdmin][equals]=true", { superAdmin: false });

  const left = await context.payload.count({
    collection: "users",
    where: { superAdmin: { equals: true } },
  });
  expect(left.totalDocs).toBe(1);
});
