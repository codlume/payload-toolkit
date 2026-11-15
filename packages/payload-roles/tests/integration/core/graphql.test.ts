import { afterAll, beforeAll, expect, test } from "vitest";

import { graphql, login, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;

beforeAll(async () => {
  context = await createTestPayload({ name: "graphql" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const reader = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  await seedUser(payload, { email: "reader@example.com", roles: [reader] });
  await seedUser(payload, { email: "nobody@example.com" });
  await payload.create({ collection: "pages", data: { title: "Home" } });
});

afterAll(() => context.destroy());

test("GraphQL resolves roles from the ids the JWT strategy loads at depth 0", async () => {
  const query = "{ Pages { totalDocs } }";

  const allowed = await graphql(context, await login(context.payload, "reader@example.com"), query);
  const denied = await graphql(context, await login(context.payload, "nobody@example.com"), query);

  expect(allowed).toEqual({ data: { Pages: { totalDocs: 1 } } });
  expect(denied.data).toEqual({ Pages: null });
  expect(denied.errors?.map((error) => error.message)).toEqual([
    "You are not allowed to perform this action.",
  ]);
});
