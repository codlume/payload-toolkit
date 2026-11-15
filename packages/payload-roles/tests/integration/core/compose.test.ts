// Finding 5: an app access function that returns nothing is a denial in Payload. Composing it
// with the roles-side self-read `Where` must stay a denial.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let reader: Actor;

beforeAll(async () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    // An access function written in JavaScript can return undefined. Payload's `Access` type
    // cannot spell that, so a bare mock, which returns undefined, stands in for it.
    usersCollection.access = { read: vi.fn() };
  }
  context = await createTestPayload({ collections, name: "compose" });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  const pagesReader = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  reader = await seedUser(payload, { email: "reader@example.com", roles: [pagesReader] });
});

afterAll(() => context.destroy());

test("an app read access that returns undefined denies the self-read a role would otherwise allow", async () => {
  await rejectsWith(as(context.payload, reader).find({ collection: "users" }), "Forbidden");

  const response = await rest(context, await login(context.payload, reader.email))("GET", "/users");
  expect(response.status).toBe(403);
});
