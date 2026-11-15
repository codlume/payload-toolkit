// Finding 7: when the roles lookup fails, every request sharing that lookup is denied. None of
// them surfaces the lookup's error.
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { type Actor, as, fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let shared: Actor;

/** Makes every database read of the roles collection fail while the request carries `failRoles`. */
const failRolesReads = ({ payload }: TestPayload) => {
  const { db } = payload;
  const find = db.find.bind(db);
  vi.spyOn(db, "find").mockImplementation((args) => {
    if (args.collection === "roles" && args.req?.context?.failRoles === true) {
      return Promise.reject(new Error("roles unavailable"));
    }
    return find(args);
  });
};

beforeAll(async () => {
  context = await createTestPayload({ name: "resolver" });
  failRolesReads(context);
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  const pagesReader = await seedRole(payload, "pages-reader", {
    collections: { pages: { actions: ["read"] } },
  });
  const user = await seedUser(payload, { email: "reader@example.com", roles: [pagesReader] });
  shared = await fresh(payload, user.id);
});

afterAll(() => context.destroy());

test("concurrent requests that share one failed roles lookup are all denied, then recover", async () => {
  const { payload } = context;
  const outcomes = await Promise.allSettled(
    Array.from({ length: 3 }, () =>
      as(payload, shared).find({ collection: "pages", context: { failRoles: true } }),
    ),
  );

  expect(
    outcomes.map((outcome) =>
      outcome.status === "rejected" && outcome.reason instanceof Error
        ? outcome.reason.name
        : outcome.status,
    ),
  ).toEqual(["Forbidden", "Forbidden", "Forbidden"]);
  expect(context.logs).toContainEqual(
    expect.objectContaining({ event: "capabilities_unavailable", plugin: "roles" }),
  );

  const recovered = await as(payload, shared).find({ collection: "pages" });
  expect(recovered.totalDocs).toBe(0);
});
