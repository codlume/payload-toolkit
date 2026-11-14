// An app `beforeOperation` hook may hand Payload a new request. The last-super-admin rule must
// hold across the documents of one bulk, both when the plugin can follow the operation to that
// request and when the hook leaves nothing to follow.
import { createLocalReq, type CollectionBeforeOperationHook, type PayloadRequest } from "payload";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { type Actor, login, rest, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

/** A copy of args keeps the plugin's record. A swap in place on rebuilt args loses it. */
const HANDOVERS = ["copy", "in place and rebuilt"] as const;

const state: {
  handover: (typeof HANDOVERS)[number] | "one cached request";
  cached: PayloadRequest | undefined;
} = { cached: undefined, handover: "copy" };

const swapRequest: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  const shared = state.handover === "one cached request";
  if (operation !== "update" && (shared || operation !== "delete")) {
    return args;
  }
  const fresh = () => createLocalReq(req.user ? { user: req.user } : {}, req.payload);
  if (shared) {
    state.cached ??= await fresh();
  }
  const swapped = state.cached ?? (await fresh());
  if (state.handover === "copy") {
    return { ...args, req: swapped };
  }
  const next = { ...Object.assign(args, { req: swapped }) };
  for (const key of Object.getOwnPropertySymbols(next)) {
    Reflect.deleteProperty(next, key);
  }
  return next;
};

let context: TestPayload;
let first: Actor;
let second: Actor;
let third: Actor;

beforeEach(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, { hooks: { beforeOperation: [swapRequest] } })
        : collection,
    ),
    name: "swapped-request",
  });
  state.cached = undefined;
  state.handover = "copy";
  first = await seedUser(context.payload, { email: "first@example.com", superAdmin: true });
  second = await seedUser(context.payload, { email: "second@example.com", superAdmin: true });
  third = await seedUser(context.payload, { email: "third@example.com", superAdmin: true });
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

describe.each(HANDOVERS)("when an app hook swaps the request (%s)", (handover) => {
  test("a bulk delete of every super admin leaves one", async () => {
    const call = await asFirst();
    state.handover = handover;

    const response = await call("DELETE", "/users?where[superAdmin][equals]=true");

    expect(await activeSuperAdmins()).toBe(1);
    expect(response.json).toMatchObject({ errors: [{ message: expect.any(String) }] });
  });

  test("a bulk demotion of every super admin leaves one", async () => {
    const call = await asFirst();
    state.handover = handover;

    const response = await call("PATCH", "/users?where[superAdmin][equals]=true", {
      superAdmin: false,
    });

    expect(await activeSuperAdmins()).toBe(1);
    expect(response.json).toMatchObject({ errors: [{ message: expect.any(String) }] });
  });
});

test("writes moved onto one long-lived request cannot add up to no super admin", async () => {
  const call = await asFirst();
  state.handover = "one cached request";

  const demoted = await call("PATCH", `/users/${second.id}`, { superAdmin: false });
  const deleted = await call("DELETE", `/users/${third.id}`);
  const last = await call("PATCH", `/users/${first.id}`, { superAdmin: false });

  expect([demoted.status, deleted.status]).toEqual([200, 200]);
  expect(await activeSuperAdmins()).toBe(1);
  expect(last.status).toBe(403);
});
