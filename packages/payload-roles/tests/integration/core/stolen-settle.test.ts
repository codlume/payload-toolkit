// An app `beforeOperation` hook remembers the args of the operation in progress and builds a
// nested operation's args from them, which copies the outer operation's settle onto the nested
// operation. The outer hook then swaps the request in place and returns rebuilt args, and a
// trusted nested write on the swapped request follows. The nested settler must not settle the
// outer record, or the outer record never learns the swapped request and the trusted record
// judges the editor's write alone.
import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  createLocalReq,
  updateByIDOperation,
} from "payload";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

import { type Actor, as, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const state: {
  attack: boolean;
  nest: boolean;
  remember: boolean;
  swap: boolean;
  saved: object | undefined;
} = {
  attack: false,
  remember: true,
  nest: false,
  swap: true,
  saved: undefined,
};

const rememberAndSwap: CollectionBeforeOperationHook = async ({ args, operation, req }) => {
  if (operation !== "update") {
    return args;
  }
  if (req.context.inner) {
    const saved = state.remember ? state.saved : undefined;
    state.saved = undefined;
    return saved
      ? {
          ...saved,
          collection: args.collection,
          data: args.data,
          depth: args.depth,
          id: Reflect.get(args, "id"),
          overrideAccess: args.overrideAccess,
          req: args.req,
        }
      : args;
  }
  if (!state.attack || req.context.swapped) {
    return args;
  }
  state.attack = false;
  state.saved = args;
  await req.payload
    .update({
      collection: "users",
      context: { inner: true },
      data: {},
      id: 999_999,
      overrideAccess: true,
    })
    .catch(() => undefined);
  if (!state.swap) {
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
              beforeOperation: [rememberAndSwap],
            },
          })
        : collection,
    ),
    name: "stolen-settle",
  });
  const { payload } = context;
  target = await seedUser(payload, { email: "super@example.com", superAdmin: true });
  const usersEditor = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update", "delete"] } },
  });
  editor = await seedUser(payload, { email: "editor@example.com", roles: [usersEditor] });
});

beforeEach(async () => {
  Object.assign(state, {
    attack: false,
    nest: false,
    remember: true,
    swap: true,
    saved: undefined,
  });
  await context.payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: target.id,
    overrideAccess: true,
  });
});

afterAll(() => context.destroy());

const logsIn = (email: string, password: string) =>
  login(context.payload, email, password).then(
    () => true,
    () => false,
  );

test("control: without the remembered args the swapped write is refused", async () => {
  const call = rest(context, await login(context.payload, editor.email));
  state.nest = true;
  state.attack = true;
  state.remember = false;

  const response = await call("PATCH", `/users/${target.id}`, { password: "control attacker" });

  expect(await logsIn(target.email, "control attacker")).toBe(false);
  expect(response.status).toBe(403);
});

test("an editor cannot change a super admin's password over REST", async () => {
  const call = rest(context, await login(context.payload, editor.email));
  state.nest = true;
  state.attack = true;

  const response = await call("PATCH", `/users/${target.id}`, { password: "rest attacker" });

  expect(await logsIn(target.email, "rest attacker")).toBe(false);
  expect(await logsIn(target.email, PASSWORD)).toBe(true);
  expect(response.status).toBe(403);
});

test("an editor cannot change a super admin's password over the Local API", async () => {
  state.nest = true;
  state.attack = true;

  const attempt = as(context.payload, editor).update({
    collection: "users",
    data: { password: "local attacker" },
    id: target.id,
  });
  const outcome = await attempt.then(
    () => "resolved",
    (error: unknown) => String(error),
  );

  expect(await logsIn(target.email, "local attacker")).toBe(false);
  expect(await logsIn(target.email, PASSWORD)).toBe(true);
  expect(outcome).toMatch(/Forbidden|not allowed/u);
});

test("without a swap, the stolen settle hides the client's password from the guard", async () => {
  const call = rest(context, await login(context.payload, editor.email));
  state.nest = true;
  state.attack = true;
  state.swap = false;

  const response = await call("PATCH", `/users/${target.id}`, { password: "hidden attacker" });

  expect(await logsIn(target.email, "hidden attacker")).toBe(false);
  expect(await logsIn(target.email, PASSWORD)).toBe(true);
  expect(response.status).toBe(403);
});
