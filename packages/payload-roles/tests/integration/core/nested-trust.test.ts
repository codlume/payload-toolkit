// An app hook may start its own operations on the users and roles collections: trusted or not,
// through the Local API or by calling an exported operation that starts synchronously with
// `disableTransaction: true`, caught on failure, alone or concurrently. None of that may change
// how the outer write is judged, and trusted writes must keep working.
import {
  type CollectionAfterChangeHook,
  type CollectionBeforeChangeHook,
  type CollectionConfig,
  createLocalReq,
  type PayloadRequest,
  updateByIDOperation,
} from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { as, login, rest, seedRole, seedUser, type Actor } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

type Nested =
  | "none"
  | "local-api-trusted"
  | "direct-trusted"
  | "direct-trusted-throws"
  | "direct-trusted-siblings"
  | "direct-trusted-outer-req"
  | "direct-trusted-same-document"
  | "direct-trusted-same-document-local"
  | "direct-trusted-missing-outer-req"
  | "direct-untrusted"
  | "strip-password"
  | "touch-other-user"
  | "nested-then-strip-password";

const NESTED: readonly Nested[] = [
  "none",
  "local-api-trusted",
  "direct-trusted",
  "direct-trusted-throws",
  "direct-trusted-siblings",
  "direct-trusted-outer-req",
  "direct-trusted-same-document",
  "direct-trusted-same-document-local",
  "direct-trusted-missing-outer-req",
  "direct-untrusted",
  "strip-password",
  "touch-other-user",
];

const state: {
  nested: Nested;
  afterChange: "none" | "trusted-same-document" | "untrusted-padded-id";
  paddedError: unknown;
  touchError: unknown;
  touchTarget: number | string;
  editorDoc: Record<string, unknown> | undefined;
  adminRoleId: number | string;
  roleId: number | string;
  bystanderId: number | string;
  localReq: PayloadRequest | undefined;
} = {
  nested: "none",
  afterChange: "none",
  paddedError: undefined,
  touchError: undefined,
  touchTarget: 0,
  editorDoc: undefined,
  adminRoleId: 0,
  roleId: 0,
  bystanderId: 0,
  localReq: undefined,
};

const nestedWrites: CollectionBeforeChangeHook = async ({ data, originalDoc, req }) => {
  const { payload } = req;
  const roles = payload.collections.roles;
  const users = payload.collections.users;
  if (!roles || !users || !state.localReq) {
    throw new Error("fixture incomplete");
  }
  const localReq = state.localReq;
  const nested = state.nested;
  state.nested = "none";
  const describeRole = (description: string, id = state.roleId) =>
    updateByIDOperation({
      collection: roles,
      data: { description },
      depth: 0,
      disableTransaction: true,
      id,
      overrideAccess: true,
      req: localReq,
    });
  switch (nested) {
    case "none":
      break;
    case "local-api-trusted":
      await payload.update({
        collection: "roles",
        data: { description: "local api" },
        id: state.roleId,
      });
      break;
    case "direct-trusted":
      await describeRole("direct");
      break;
    case "direct-trusted-throws":
      await describeRole("missing", 987_654).catch(() => undefined);
      break;
    case "direct-trusted-siblings":
      await Promise.all([describeRole("sibling one"), describeRole("sibling two")]);
      break;
    case "direct-trusted-outer-req":
      await updateByIDOperation({
        collection: users,
        data: {},
        depth: 0,
        disableTransaction: true,
        id: state.bystanderId,
        overrideAccess: true,
        req,
      });
      break;
    case "direct-trusted-same-document":
    case "direct-trusted-same-document-local":
      if (
        isRecord(originalDoc) &&
        (typeof originalDoc.id === "number" || typeof originalDoc.id === "string")
      ) {
        await updateByIDOperation({
          collection: users,
          data: { roles: Array.isArray(originalDoc.roles) ? originalDoc.roles : [] },
          depth: 0,
          disableTransaction: true,
          id: originalDoc.id,
          overrideAccess: true,
          req: nested === "direct-trusted-same-document" ? req : localReq,
        });
      }
      break;
    case "direct-trusted-missing-outer-req":
      await updateByIDOperation({
        collection: users,
        data: {},
        depth: 0,
        disableTransaction: true,
        id: 987_654,
        overrideAccess: true,
        req,
      }).catch(() => undefined);
      break;
    case "nested-then-strip-password":
      if (
        isRecord(originalDoc) &&
        (typeof originalDoc.id === "number" || typeof originalDoc.id === "string")
      ) {
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
    case "touch-other-user":
      await payload
        .update({ collection: "users", data: {}, id: state.touchTarget, req })
        .catch((error: unknown) => {
          state.touchError = error;
        });
      break;
    case "strip-password":
      return Object.fromEntries(Object.entries(data).filter(([key]) => key !== "password"));
    case "direct-untrusted":
      await updateByIDOperation({
        collection: roles,
        data: { description: "untrusted" },
        depth: 0,
        disableTransaction: true,
        id: state.roleId,
        overrideAccess: false,
        req,
      }).catch(() => undefined);
      break;
  }
  return data;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const followUp: CollectionAfterChangeHook = async ({ doc, req }) => {
  const mode = state.afterChange;
  state.afterChange = "none";
  if (mode === "trusted-same-document") {
    await req.payload.update({
      collection: "users",
      data: { roles: [state.roleId, state.adminRoleId] },
      id: doc.id,
    });
  }
  if (mode === "untrusted-padded-id" && state.editorDoc) {
    await req.payload
      .update({
        collection: "users",
        data: { roles: [state.adminRoleId] },
        id: `0${String(doc.id)}`,
        overrideAccess: false,
        req,
        user: state.editorDoc,
      })
      .catch((error: unknown) => {
        state.paddedError = error;
      });
  }
  return doc;
};

const collections = (): CollectionConfig[] =>
  fixtureCollections().map((collection) =>
    collection.slug === "users"
      ? Object.assign(collection, {
          hooks: { afterChange: [followUp], beforeChange: [nestedWrites] },
        })
      : collection,
  );

let context: TestPayload;
let editor: Actor;
let target: Actor;
let editorToken: string;

const stored = (id: number | string) =>
  context.payload.db.findOne({ collection: "users", where: { id: { equals: id } } });

beforeAll(async () => {
  context = await createTestPayload({ collections: collections(), name: "nested-trust" });
  const { payload } = context;
  state.localReq = await createLocalReq({}, payload);
  await seedUser(payload, { email: "root@example.test", superAdmin: true });
  state.roleId = await seedRole(payload, "users-editor", {
    collections: { users: { actions: ["read", "update"] } },
  });
  state.adminRoleId = await seedRole(payload, "users-admin", {
    collections: {
      roles: { actions: ["read", "update"] },
      users: { actions: ["read", "update", "delete"] },
    },
  });
  editor = await seedUser(payload, { email: "editor@example.test", roles: [state.roleId] });
  state.editorDoc = editor;
  target = await seedUser(payload, { email: "target@example.test", superAdmin: true });
  state.touchTarget = target.id;
  state.bystanderId = (await seedUser(payload, { email: "bystander@example.test" })).id;
  editorToken = await login(payload, "editor@example.test");
});

afterAll(async () => {
  state.nested = "none";
  await context.destroy();
});

const withNested = async <Result>(nested: Nested, run: () => Promise<Result>) => {
  state.nested = nested;
  try {
    return await run();
  } finally {
    state.nested = "none";
  }
};

describe.each(NESTED)("with an app hook whose nested write is %s", (nested) => {
  test("an editor's REST password change on a super admin stays refused", async () => {
    const response = await withNested(nested, () =>
      rest(context, editorToken)("PATCH", `/users/${target.id}`, {
        password: "takeover-attempt-password",
      }),
    );
    expect(response.status).toBe(403);
    await expect(
      login(context.payload, "target@example.test", "takeover-attempt-password"),
    ).rejects.toThrow();
  });

  test("an editor's Local API email change on a super admin stays refused", async () => {
    await withNested(nested, () =>
      rejectsWith(
        as(context.payload, editor).update({
          collection: "users",
          data: { email: "attacker@example.test" },
          id: target.id,
        }),
        "Forbidden",
      ),
    );
    expect(await stored(target.id)).toMatchObject({ email: "target@example.test" });
  });

  test("an editor still cannot give another user a role they do not cover", async () => {
    await withNested(nested, () =>
      rejectsWith(
        as(context.payload, editor).update({
          collection: "users",
          data: { roles: [state.adminRoleId] },
          id: state.bystanderId,
        }),
        "Forbidden",
      ),
    );
    expect(await stored(state.bystanderId)).toMatchObject({ roles: [] });
  });

  test("an editor still cannot make themselves a super admin", async () => {
    await withNested(nested, () =>
      rejectsWith(
        as(context.payload, editor).update({
          collection: "users",
          data: { superAdmin: true },
          id: editor.id,
        }),
        "Forbidden",
      ),
    );
    expect(await stored(editor.id)).not.toMatchObject({ superAdmin: true });
  });
});

test("a trusted Local API write still works while the hook runs a direct trusted operation", async () => {
  await withNested("direct-trusted", () =>
    context.payload.update({ collection: "users", data: { superAdmin: true }, id: editor.id }),
  );
  expect(await stored(editor.id)).toMatchObject({ superAdmin: true });
  const role = await context.payload.findByID({ collection: "roles", id: state.roleId });
  expect(role.description).toBe("direct");
  await context.payload.update({ collection: "users", data: { superAdmin: false }, id: editor.id });
  expect(await stored(editor.id)).toMatchObject({ superAdmin: false });
});

test("a trusted Local API restore of a role version still works", async () => {
  const { payload } = context;
  const role = await seedRole(payload, "restorable", {
    collections: { pages: { actions: ["read"] } },
  });
  await payload.update({ collection: "roles", data: { description: "second" }, id: role });
  const versions = await payload.findVersions({
    collection: "roles",
    sort: "createdAt",
    where: { parent: { equals: role } },
  });
  const first = versions.docs[0];
  if (!first) {
    throw new Error("expected a role version");
  }
  await payload.restoreVersion({ collection: "roles", id: first.id });
  const restored = await payload.findByID({ collection: "roles", id: role });
  expect(restored.description).not.toBe("second");
});

test("a trusted write from an afterChange hook on the same document still works inside an editor's write", async () => {
  state.afterChange = "trusted-same-document";
  await as(context.payload, editor).update({
    collection: "users",
    data: { email: "editor-renamed@example.test" },
    id: editor.id,
  });
  expect(await stored(editor.id)).toMatchObject({
    email: "editor-renamed@example.test",
    roles: [state.roleId, state.adminRoleId],
  });
  await context.payload.update({
    collection: "users",
    data: { email: "editor@example.test", roles: [state.roleId] },
    id: editor.id,
  });
});

test("an untrusted write naming its document by a non-canonical id inside a trusted write stays untrusted", async () => {
  state.afterChange = "untrusted-padded-id";
  state.paddedError = undefined;
  await context.payload.update({ collection: "users", data: {}, id: state.bystanderId });
  expect(state.paddedError).toMatchObject({ name: "Forbidden" });
  expect(await stored(state.bystanderId)).toMatchObject({ roles: [] });
});

test("a user's own profile save still works while an app hook writes a stronger user with req", async () => {
  state.touchError = undefined;
  const selfToken = await login(context.payload, "editor@example.test");
  const response = await withNested("touch-other-user", () =>
    rest(context, selfToken)("PATCH", `/users/${editor.id}`, {
      email: "editor-own@example.test",
      password: "editor-own-new-password",
    }),
  );
  expect(state.touchError).toBeUndefined();
  expect(response.status).toBe(200);
  expect(await stored(editor.id)).toMatchObject({ email: "editor-own@example.test" });
  editorToken = await login(context.payload, "editor-own@example.test", "editor-own-new-password");
  await context.payload.update({
    collection: "users",
    data: { email: "editor@example.test", password: "correct horse battery staple" },
    id: editor.id,
  });
  editorToken = await login(context.payload, "editor@example.test");
});

test("an editor's save of a covered user still works while an app hook writes a stronger user with req", async () => {
  state.touchError = undefined;
  await withNested("touch-other-user", () =>
    as(context.payload, editor).update({
      collection: "users",
      data: { email: "bystander-renamed@example.test" },
      id: state.bystanderId,
    }),
  );
  expect(state.touchError).toBeUndefined();
  expect(await stored(state.bystanderId)).toMatchObject({
    email: "bystander-renamed@example.test",
  });
  await context.payload.update({
    collection: "users",
    data: { email: "bystander@example.test" },
    id: state.bystanderId,
  });
});

test.each([
  (id: number | string) => `0${String(id)}`,
  (id: number | string) => `${String(id)}e0`,
  (id: number | string) => `${String(id)}.`,
])(
  "a password sent by a non-canonical id stays judged when a hook nests a write and strips it (%#)",
  async (spell) => {
    await withNested("nested-then-strip-password", () =>
      rejectsWith(
        context.payload.update({
          collection: "users",
          data: { password: "takeover-attempt-password" },
          id: spell(target.id),
          overrideAccess: false,
          user: editor,
        }),
        "Forbidden",
      ),
    );
    await expect(
      login(context.payload, "target@example.test", "takeover-attempt-password"),
    ).rejects.toThrow();
  },
);
