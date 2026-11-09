// An app may resolve an alias to a document id in `beforeOperation`, after the plugin recorded
// the write. The write must still be judged as the document Payload actually acts on.
import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  updateByIDOperation,
} from "payload";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";

import { as, login, PASSWORD, rest, seedRole, seedUser, type Actor } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

type Rewrite = "mutate" | "replace";
type Nested = "none" | "trusted" | "untrusted";

const state: {
  rewrite: Rewrite;
  nested: Nested;
  strip: boolean;
  bulkId: number | string | undefined;
  replaceArgs: boolean;
  touch: number | string | undefined;
  touchError: unknown;
} = {
  rewrite: "mutate",
  nested: "none",
  strip: false,
  bulkId: undefined,
  replaceArgs: false,
  touch: undefined,
  touchError: undefined,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolveAlias: CollectionBeforeOperationHook = async ({ args, req }) => {
  const source: unknown = args;
  const id = isRecord(source) ? source.id : undefined;
  if (isRecord(source) && id === undefined && state.bulkId !== undefined) {
    source.id = state.bulkId;
  }
  if (typeof id !== "string" || !id.startsWith("alias:")) {
    return state.replaceArgs ? { ...args } : args;
  }
  const row = await req.payload.db.findOne({
    collection: "users",
    req,
    where: { email: { equals: id.slice("alias:".length) } },
  });
  if (state.rewrite === "replace") {
    return { ...args, id: row?.id };
  }
  return Object.assign(args, { id: row?.id });
};

const nestAndStrip: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const users = req.payload.collections.users;
  const nested = state.nested;
  state.nested = "none";
  if (users && nested !== "none" && isRecord(originalDoc)) {
    const id = originalDoc.id;
    if (typeof id === "number" || typeof id === "string") {
      await updateByIDOperation({
        collection: users,
        data: {},
        depth: 0,
        disableTransaction: true,
        id,
        overrideAccess: nested === "trusted",
        req,
      }).catch(() => undefined);
    }
  }
  if (state.touch !== undefined) {
    const touch = state.touch;
    state.touch = undefined;
    await req.payload
      .update({ collection: "users", data: {}, id: touch, req })
      .catch((error: unknown) => {
        state.touchError = error;
      });
  }
  return state.strip
    ? Object.fromEntries(Object.entries(data).filter(([key]) => key !== "password"))
    : data;
};

const collections = (): CollectionConfig[] =>
  fixtureCollections().map((collection) =>
    collection.slug === "users"
      ? Object.assign(collection, {
          hooks: { beforeChange: [nestAndStrip], beforeOperation: [resolveAlias] },
        })
      : collection,
  );

let context: TestPayload;
let editor: Actor;
let editorToken: string;

beforeAll(async () => {
  context = await createTestPayload({ collections: collections(), name: "id-rewrite" });
  const { payload } = context;
  await seedUser(payload, { email: "root@example.test", superAdmin: true });
  const role = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update"] } },
  });
  editor = await seedUser(payload, { email: "editor@example.test", roles: [role] });
  ALIAS_TARGET_ID.value = (
    await seedUser(payload, { email: "target@example.test", superAdmin: true })
  ).id;
  editorToken = await login(payload, "editor@example.test");
});

afterAll(async () => context.destroy());

afterEach(async () => {
  Object.assign(state, {
    bulkId: undefined,
    nested: "none",
    replaceArgs: false,
    strip: false,
    touch: undefined,
    touchError: undefined,
  });
  await context.payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: ALIAS_TARGET_ID.value,
  });
});

const ALIAS_TARGET_ID: { value: number | string } = { value: 0 };

const ALIAS = "alias:target@example.test";
const ATTEMPT = "takeover-attempt-password";

const cases = (["mutate", "replace"] as const).flatMap((rewrite) =>
  (["none", "trusted", "untrusted"] as const).flatMap((nested) =>
    [false, true].map((strip) => ({ nested, rewrite, strip })),
  ),
);

describe.each(cases)(
  "alias $rewrite, nested $nested, strip $strip",
  ({ nested, rewrite, strip }) => {
    const arm = () => Object.assign(state, { nested, rewrite, strip });
    const disarm = () => Object.assign(state, { nested: "none", strip: false });

    test("an editor's Local API password change on a super admin by alias stays refused", async () => {
      arm();
      try {
        await rejectsWith(
          as(context.payload, editor).update({
            collection: "users",
            data: { password: ATTEMPT },
            id: ALIAS,
          }),
          "Forbidden",
        );
      } finally {
        disarm();
      }
      await expect(login(context.payload, "target@example.test", ATTEMPT)).rejects.toThrow();
    });

    test("an editor's REST password change on a super admin by alias stays refused", async () => {
      arm();
      const response = await rest(context, editorToken)("PATCH", `/users/${ALIAS}`, {
        password: ATTEMPT,
      }).finally(disarm);
      expect([400, 403]).toContain(response.status);
      await expect(login(context.payload, "target@example.test", ATTEMPT)).rejects.toThrow();
    });
  },
);

test("a trusted Local API write by alias still works", async () => {
  await context.payload.update({ collection: "users", data: { superAdmin: true }, id: ALIAS });
  const row = await context.payload.db.findOne({
    collection: "users",
    where: { email: { equals: "target@example.test" } },
  });
  expect(row).toMatchObject({ superAdmin: true });
});

test("a bulk update whose args gain an id from an app hook still judges every matched row", async () => {
  Object.assign(state, { bulkId: editor.id, nested: "trusted", strip: true });
  const result = await as(context.payload, editor).updateMany({
    collection: "users",
    data: { password: ATTEMPT },
    where: { email: { equals: "target@example.test" } },
  });
  expect(result.docs).toHaveLength(0);
  await expect(login(context.payload, "target@example.test", ATTEMPT)).rejects.toThrow();
});

test("an app hook that returns a copy of args keeps trusted writes to other users working", async () => {
  const bystander = await seedUser(context.payload, { email: "bystander@example.test" });
  Object.assign(state, { replaceArgs: true, touch: ALIAS_TARGET_ID.value });
  await as(context.payload, editor).update({
    collection: "users",
    data: { email: "bystander-renamed@example.test" },
    id: bystander.id,
  });
  expect(state.touchError).toBeUndefined();
  const row = await context.payload.db.findOne({
    collection: "users",
    where: { id: { equals: bystander.id } },
  });
  expect(row).toMatchObject({ email: "bystander-renamed@example.test" });
});
