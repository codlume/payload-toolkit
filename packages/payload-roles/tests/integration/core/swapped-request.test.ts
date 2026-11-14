// An app `beforeOperation` hook may hand Payload a new request. The last-super-admin rule must
// hold across the documents of one bulk, both when the plugin can follow the operation to that
// request and when the hook leaves nothing to follow.
import { createLocalReq, type CollectionBeforeOperationHook } from "payload";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { login, rest, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

/** A copy of args keeps the plugin's record. A swap in place on rebuilt args loses it. */
const HANDOVERS = ["copy", "in place and rebuilt"] as const;

const state: { handover: (typeof HANDOVERS)[number] } = { handover: "copy" };

const swapRequest: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== "delete" && operation !== "update") {
    return args;
  }
  const swapped = await createLocalReq(req.user ? { user: req.user } : {}, req.payload);
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

beforeEach(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, { hooks: { beforeOperation: [swapRequest] } })
        : collection,
    ),
    name: "swapped-request",
  });
  state.handover = "copy";
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
