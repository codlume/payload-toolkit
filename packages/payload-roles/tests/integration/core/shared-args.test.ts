// App code can resolve an id in beforeOperation, start another operation with the same args
// object without awaiting it, and return a copy of args. The editor's write must still be judged
// against the document Payload acts on.
import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  updateByIDOperation,
} from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { as, login, seedRole, seedUser, type Actor } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const state = { armed: false, strip: false };

const shareAndCopy: CollectionBeforeOperationHook = async ({ args, req }) => {
  const source: unknown = args;
  const id = isRecord(source) ? source.id : undefined;
  if (!state.armed || typeof id !== "string" || !id.startsWith("alias:")) {
    return args;
  }
  const row = await req.payload.db.findOne({
    collection: "users",
    req,
    where: { email: { equals: id.slice("alias:".length) } },
  });
  Object.assign(args, { id: row?.id });
  const users = req.payload.collections.users;
  if (users && isRecord(source)) {
    void Reflect.apply(updateByIDOperation, undefined, [
      Object.assign(args, { disableTransaction: true }),
    ]).catch(() => undefined);
  }
  return { ...args };
};

const nestAndStrip: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const users = req.payload.collections.users;
  if (state.armed && users && isRecord(originalDoc)) {
    state.armed = false;
    const id = originalDoc.id;
    if (typeof id === "number" || typeof id === "string") {
      await updateByIDOperation({
        collection: users,
        data: {},
        depth: 0,
        disableTransaction: true,
        id,
        overrideAccess: true,
        req,
      }).catch(() => undefined);
    }
  }
  return state.strip
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "password"))
    : data;
};

const collections = (): CollectionConfig[] =>
  fixtureCollections().map((collection) =>
    collection.slug === "users"
      ? Object.assign(collection, {
          hooks: { beforeChange: [nestAndStrip], beforeOperation: [shareAndCopy] },
        })
      : collection,
  );

let context: TestPayload;
let editor: Actor;

beforeAll(async () => {
  context = await createTestPayload({ collections: collections(), name: "shared-args" });
  const { payload } = context;
  await seedUser(payload, { email: "root@example.test", superAdmin: true });
  const role = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update"] } },
  });
  editor = await seedUser(payload, { email: "editor@example.test", roles: [role] });
  await seedUser(payload, { email: "target@example.test", superAdmin: true });
});

afterAll(async () => context.destroy());

test("a password change by alias stays refused when an app hook shares and copies args", async () => {
  Object.assign(state, { armed: true, strip: true });
  await rejectsWith(
    as(context.payload, editor).update({
      collection: "users",
      data: { password: "takeover-attempt-password" },
      id: "alias:target@example.test",
    }),
    "Forbidden",
  );
  Object.assign(state, { armed: false, strip: false });
  await expect(
    login(context.payload, "target@example.test", "takeover-attempt-password"),
  ).rejects.toThrow();
});
