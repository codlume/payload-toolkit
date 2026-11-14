// An app `beforeOperation` hook swaps the request in place and returns rebuilt args, so nothing
// ties the final args to the request the operation began on. A second app hook then starts a
// trusted operation of its own on the swapped request. The editor's write must still be judged
// as the editor's: the trusted operation's record must never stand in for the missing one.
import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeDeleteHook,
  type CollectionBeforeOperationHook,
  createLocalReq,
  deleteOperation,
  updateByIDOperation,
} from "payload";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { type Actor, as, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const state = { nest: false };

const swapInPlaceAndRebuild: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if ((operation !== "update" && operation !== "delete") || req.context.swapped) {
    return args;
  }
  const swapped = await createLocalReq(
    { context: { swapped: true }, ...(req.user && { user: req.user }) },
    req.payload,
  );
  const next = { ...Object.assign(args, { req: swapped }) };
  for (const key of Object.getOwnPropertySymbols(next)) {
    Reflect.deleteProperty(next, key);
  }
  return next;
};

/** Starts a trusted update of the same user on the request it was given, then drops `password`. */
const touchAndDropPassword: CollectionBeforeChangeHook = async ({
  data,
  operation,
  originalDoc,
  req,
}) => {
  const users = req.payload.collections.users;
  if (operation !== "update" || !users) {
    return data;
  }
  if (state.nest) {
    state.nest = false;
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
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== "password"));
};

/** Starts a trusted bulk delete that matches nobody on the request it was given. */
const sweepNobody: CollectionBeforeDeleteHook = async ({ req }) => {
  const users = req.payload.collections.users;
  if (state.nest && users) {
    state.nest = false;
    await deleteOperation({
      collection: users,
      depth: 0,
      disableTransaction: true,
      overrideAccess: true,
      req,
      where: { email: { equals: "nobody@example.com" } },
    });
  }
};

let context: TestPayload;
let editor: Actor;
let target: Actor;

beforeAll(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "users"
        ? Object.assign(collection, {
            auth: { maxLoginAttempts: 0 },
            hooks: {
              beforeChange: [touchAndDropPassword],
              beforeDelete: [sweepNobody],
              beforeOperation: [swapInPlaceAndRebuild],
            },
          })
        : collection,
    ),
    name: "swapped-request-nested",
  });
  const { payload } = context;
  target = await seedUser(payload, { email: "super@example.com", superAdmin: true });
  const usersEditor = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update", "delete"] } },
  });
  editor = await seedUser(payload, { email: "editor@example.com", roles: [usersEditor] });
});

beforeEach(() => {
  state.nest = false;
});

afterAll(() => context.destroy());

const logsIn = (email: string, password: string) =>
  login(context.payload, email, password).then(
    () => true,
    () => false,
  );

const storedTarget = () =>
  context.payload.db.findOne({ collection: "users", where: { id: { equals: target.id } } });

test("an editor cannot change a super admin's password over REST", async () => {
  const call = rest(context, await login(context.payload, editor.email));
  state.nest = true;

  const response = await call("PATCH", `/users/${target.id}`, { password: "rest attacker" });

  expect(await logsIn(target.email, "rest attacker")).toBe(false);
  expect(await logsIn(target.email, PASSWORD)).toBe(true);
  expect(response.status).toBe(403);
});

test("an editor cannot change a super admin's password over the Local API", async () => {
  state.nest = true;

  const attempt = as(context.payload, editor).update({
    collection: "users",
    data: { password: "local attacker" },
    id: target.id,
  });
  await attempt.catch(() => undefined);

  expect(await logsIn(target.email, "local attacker")).toBe(false);
  expect(await logsIn(target.email, PASSWORD)).toBe(true);
  await rejectsWith(attempt, "Forbidden");
});

test("an editor cannot delete a super admin", async () => {
  const call = rest(context, await login(context.payload, editor.email));
  state.nest = true;

  const response = await call("DELETE", `/users/${target.id}`);

  expect(await storedTarget()).toMatchObject({ email: target.email, superAdmin: true });
  expect(response.status).toBe(403);
});
