// An app `beforeOperation` hook may hand Payload a new request, and an app `beforeChange` hook
// may drop `password` from the data. Payload saves the password it read before any hook ran, so
// the write must still be judged on the body the client sent, under the request Payload acts on.
import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  createLocalReq,
  type PayloadRequest,
} from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type Actor, as, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

/**
 * How the app hook hands over the new request: on a copy of args, on new args, or in place. Both
 * of the last two at once leaves nothing that ties the final args to the request the operation
 * began on.
 */
const HANDOVERS = ["copy", "rebuilt", "in place", "in place and rebuilt"] as const;

/** A request of its own, or one derived from the first that shares its data loader. */
const REQUESTS = ["new", "derived"] as const;

const state: {
  handover: (typeof HANDOVERS)[number];
  api: "local" | "REST";
  request: (typeof REQUESTS)[number];
} = { api: "local", handover: "copy", request: "new" };

const swapRequest: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== "update") {
    return args;
  }
  const base: PayloadRequest =
    state.request === "derived"
      ? Object.create(req)
      : await createLocalReq(req.user ? { user: req.user } : {}, req.payload);
  const swapped = Object.assign(base, { payloadAPI: state.api });
  if (state.handover === "in place") {
    return Object.assign(args, { req: swapped });
  }
  if (state.handover === "in place and rebuilt") {
    Object.assign(args, { req: swapped });
  }
  const next = { ...args, req: swapped };
  if (state.handover !== "copy") {
    // An app that builds its own args object copies the string keys it knows.
    for (const key of Object.getOwnPropertySymbols(next)) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
};

const dropPassword: CollectionBeforeChangeHook = ({ data, operation }) =>
  operation === "update"
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "password"))
    : data;

let context: TestPayload;
let editor: Actor;
let target: Actor;
let plain: Actor;

beforeAll(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, {
            auth: { maxLoginAttempts: 0 },
            fields: [{ name: "nickname", type: "text" }],
            hooks: { beforeChange: [dropPassword], beforeOperation: [swapRequest] },
          })
        : collection,
    ),
    name: "swapped-request-body",
  });
  const { payload } = context;
  target = await seedUser(payload, { email: "super@example.com", superAdmin: true });
  const usersEditor = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update"] } },
  });
  editor = await seedUser(payload, { email: "editor@example.com", roles: [usersEditor] });
  plain = await seedUser(payload, { email: "plain@example.com" });
});

beforeEach(() => {
  state.api = "local";
  state.handover = "copy";
  state.request = "new";
});

afterAll(() => context.destroy());

const stored = (id: number | string) =>
  context.payload.db.findOne({ collection: "users", where: { id: { equals: id } } });

const logsIn = (email: string, password: string) =>
  login(context.payload, email, password).then(
    () => true,
    () => false,
  );

describe.each(HANDOVERS)("when an app hook swaps the request (%s)", (handover) => {
  test("an editor cannot change a super admin's password over REST", async () => {
    state.handover = handover;
    const password = `rest attacker ${handover}`;

    const response = await rest(context, await login(context.payload, editor.email))(
      "PATCH",
      `/users/${target.id}`,
      { password },
    );

    expect(await logsIn(target.email, password)).toBe(false);
    expect(await logsIn(target.email, PASSWORD)).toBe(true);
    expect(response.status).toBe(403);
  });

  test("an editor cannot change a super admin's password over the Local API", async () => {
    state.handover = handover;
    const password = `local attacker ${handover}`;

    const attempt = as(context.payload, editor).update({
      collection: "users",
      data: { password },
      id: target.id,
    });
    await attempt.catch(() => undefined);

    expect(await logsIn(target.email, password)).toBe(false);
    expect(await logsIn(target.email, PASSWORD)).toBe(true);
    await rejectsWith(attempt, "Forbidden");
  });

  test("an editor can still change the password of a user they cover", async () => {
    state.handover = handover;
    const password = `covered ${handover}`;

    await as(context.payload, editor).update({
      collection: "users",
      data: { password },
      id: plain.id,
    });

    expect(await logsIn(plain.email, password)).toBe(true);
  });

  test("an editor can still make a harmless edit to a super admin", async () => {
    state.handover = handover;
    const nickname = `by editor, ${handover}`;

    await as(context.payload, editor).update({
      collection: "users",
      data: { nickname },
      id: target.id,
    });

    expect(await stored(target.id)).toMatchObject({ nickname });
  });

  test("a trusted Local API edit of a super admin still goes through", async () => {
    state.handover = handover;
    const nickname = `trusted, ${handover}`;

    await context.payload.update({ collection: "users", data: { nickname }, id: target.id });

    expect(await stored(target.id)).toMatchObject({ nickname });
  });

  test("a trusted Local API write still goes through", async () => {
    state.handover = handover;

    const promoted = await context.payload.update({
      collection: "users",
      data: { superAdmin: true },
      id: plain.id,
    });
    const demoted = await context.payload.update({
      collection: "users",
      data: { superAdmin: false },
      id: plain.id,
    });

    expect([promoted.superAdmin, demoted.superAdmin]).toEqual([true, false]);
  });
});

describe.each(REQUESTS)("when an app hook moves a trusted write to a %s request", (request) => {
  test("the write is judged once that request is not local", async () => {
    state.api = "REST";
    state.request = request;

    const attempt = context.payload.update({
      collection: "users",
      data: { superAdmin: true },
      id: plain.id,
    });
    await attempt.catch(() => undefined);

    expect(await stored(plain.id)).toMatchObject({ superAdmin: false });
    await rejectsWith(attempt, "Forbidden");
  });
});
