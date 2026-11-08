import { createLocalReq, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { PermissionsField } from "@codlume/payload-roles";
import { PermissionsMatrix } from "@codlume/payload-roles/client";

import {
  applyOp,
  type Outcome,
  placeServerIssues,
  readMatrix,
  takeServerIssues,
} from "../../../src/admin/client/matrix.ts";
import type { Grant, MatrixModel } from "../../../src/admin/model.ts";
import { type Actor, as, fresh, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

// The client entry imports @payloadcms/ui, whose CSS imports Node cannot load.
vi.mock("@codlume/payload-roles/client", () => ({ PermissionsMatrix: () => null }));

const HIDDEN = "hidden@example.com";

let context: TestPayload;
let disabled: TestPayload;
let roles: Record<"blank" | "editor" | "limited" | "strong", number | string>;
let users: Record<"editor" | "limited" | "super", Actor>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isModel = (value: unknown): value is MatrixModel =>
  isRecord(value) && Array.isArray(value.rows) && isRecord(value.stored);

const storedPermissions = async (payload: Payload, id: number | string): Promise<unknown> =>
  (await payload.findByID({ collection: "roles", depth: 0, id })).permissions;

const modelFor = async (
  { payload }: TestPayload,
  editor: Actor,
  id: number | string | undefined,
  { readOnly = false, user }: { readOnly?: boolean; user?: Record<string, unknown> } = {},
) => {
  const req = await createLocalReq({ user: await fresh(payload, editor.id) }, payload);
  const element = await PermissionsField({
    clientField: { name: "permissions", type: "json" },
    ...(id !== undefined && { id }),
    path: "permissions",
    readOnly,
    req,
    ...(user && { user }),
    value: id === undefined ? {} : await storedPermissions(payload, id),
  });
  expect(element.type).toBe(PermissionsMatrix);
  const props: unknown = element.props;
  if (!isRecord(props) || !isModel(props.model)) {
    throw new Error("PermissionsField rendered no model");
  }
  expect(props.path).toBe("permissions");
  return props.model;
};

const grantable = (model: MatrixModel): Grant[] =>
  model.rows.flatMap((row) =>
    model.columns.flatMap(({ action }): Grant[] =>
      row.cells[action] === "grantable" ? [`${row.id}#${action}`] : [],
    ),
  );

const modes = (model: MatrixModel, id: string) => model.rows.find((row) => row.id === id)?.cells;

beforeAll(async () => {
  context = await createTestPayload({
    name: "admin-permissions-field",
    collections: [
      {
        access: { read: ({ req }) => (req.user ? { email: { not_equals: HIDDEN } } : false) },
        auth: true,
        fields: [],
        slug: "users",
      },
      ...fixtureCollections().filter(({ slug }) => slug !== "users"),
    ],
  });
  const { payload } = context;
  const superAdmin = await seedUser(payload, { email: "super@example.com" });
  roles = {
    blank: await seedRole(payload, "blank", {}),
    editor: await seedRole(payload, "editor", {
      collections: {
        pages: { actions: ["read", "update", "publish"] },
        roles: { actions: ["read", "update"] },
        users: { actions: ["read"] },
      },
      globals: { settings: { actions: ["read"] } },
    }),
    limited: await seedRole(payload, "limited", {
      collections: { roles: { actions: ["update"] } },
    }),
    strong: await seedRole(payload, "strong", {
      collections: { pages: { actions: ["read", "delete"] } },
    }),
  };
  users = {
    editor: await seedUser(payload, { email: "editor@example.com", roles: [roles.editor] }),
    limited: await seedUser(payload, { email: "limited@example.com", roles: [roles.limited] }),
    super: superAdmin,
  };
  await seedUser(payload, { email: "alice@example.com", roles: [roles.blank] });
  await seedUser(payload, { email: "bob@example.com", roles: [roles.blank] });
  await seedUser(payload, { email: HIDDEN, roles: [roles.blank] });

  disabled = await createTestPayload({
    name: "admin-permissions-field-disabled",
    roles: { ...defaultRolesOptions(), enabled: false },
  });
});

afterAll(async () => {
  await context.destroy();
  await disabled.destroy();
});

describe("cell modes", () => {
  test("a member can grant exactly the cells they hold", async () => {
    const model = await modelFor(context, users.editor, roles.blank);
    expect(model.lock).toBeNull();
    expect(model.enforced).toBe(true);
    expect(modes(model, "collections:pages")).toMatchObject({
      read: "grantable",
      update: "grantable",
      publish: "grantable",
      delete: "fixed",
      unpublish: "fixed",
    });
    expect(modes(model, "globals:settings")).toMatchObject({ read: "grantable", update: "fixed" });
    expect(model.rows.map(({ label }) => label)).toEqual([
      "Users",
      "Pages",
      "Posts",
      "Notes",
      "Roles",
      "Settings",
    ]);
  });

  test("the editor comes from the request, not the read-filtered user prop", async () => {
    const model = await modelFor(context, users.editor, roles.blank, {
      user: { ...users.super, collection: "users" },
    });
    expect(modes(model, "collections:pages")).toMatchObject({ delete: "fixed" });
  });

  test("every grantable cell saves as that editor", async () => {
    const model = await modelFor(context, users.editor, roles.blank);
    const cells = grantable(model);
    expect(cells.length).toBeGreaterThan(5);
    const { value } = cells.reduce<Outcome>(
      (outcome, cell) => applyOp(model, outcome.cells, { type: "cell", cell, on: true }),
      applyOp(model, new Set(), { type: "clean" }),
    );
    await as(context.payload, users.editor).update({
      collection: "roles",
      id: roles.blank,
      data: { permissions: value },
    });
    expect(await storedPermissions(context.payload, roles.blank)).toEqual(value);
  });

  test("a role the editor does not cover is fixed, and core refuses the editor's update", async () => {
    const model = await modelFor(context, users.editor, roles.strong);
    expect(model.lock).toEqual({ kind: "not-covered", missing: ["collections:pages#delete"] });
    expect(grantable(model)).toEqual([]);
    await rejectsWith(
      as(context.payload, users.editor).update({
        collection: "roles",
        id: roles.strong,
        data: { name: "renamed" },
      }),
      "Forbidden",
    );
  });

  test("a read-only field fixes every cell", async () => {
    const model = await modelFor(context, users.editor, roles.blank, { readOnly: true });
    expect(model.lock).toEqual({ kind: "read-only" });
    expect(grantable(model)).toEqual([]);
  });

  test("disabled mode can grant every applicable cell and is marked not enforced", async () => {
    const role = await seedRole(disabled.payload, "member", {
      collections: { pages: { actions: ["read"] } },
    });
    await seedUser(disabled.payload, { email: "first@example.com" });
    const member = await seedUser(disabled.payload, { email: "member@example.com", roles: [role] });
    const model = await modelFor(disabled, member, role);
    expect(model.enforced).toBe(false);
    expect(model.lock).toBeNull();
    expect(model.rows.flatMap((row) => Object.values(row.cells))).not.toContain("fixed");
  });
});

describe("access-honoring reads", () => {
  test("copy sources are the roles the editor can read, other than this one", async () => {
    const model = await modelFor(context, users.editor, roles.blank);
    expect(model.copySources.map(({ name }) => name).toSorted()).toEqual([
      "editor",
      "limited",
      "strong",
    ]);
    expect(model.copySources.find(({ name }) => name === "strong")?.granted.toSorted()).toEqual([
      "collections:pages#delete",
      "collections:pages#read",
    ]);
    expect((await modelFor(context, users.limited, roles.limited)).copySources).toEqual([]);
  });

  test("the assignment count covers only users the editor can read, and links to them", async () => {
    const model = await modelFor(context, users.editor, roles.blank);
    expect(model.assignment).toEqual({
      count: 2,
      href: `/admin/collections/users?where[or][0][and][0][roles][in][0]=${String(roles.blank)}`,
    });
    expect((await modelFor(context, users.limited, roles.limited)).assignment).toBeNull();
    expect((await modelFor(context, users.editor, undefined)).assignment).toBeNull();
  });
});

describe("stored values the matrix did not write", () => {
  test("a malformed role shows only parsed grants, lists its issues, and cleans to a saveable value", async () => {
    const { payload } = context;
    const id = await seedRole(payload, "broken", {
      collections: {
        ghost: { actions: ["read"] },
        posts: { actions: ["read", "publish", "bogus"] },
      },
    });
    const model = await modelFor(context, users.super, id);
    const view = readMatrix(model, await storedPermissions(payload, id));
    expect(view).toMatchObject({ status: "ready", untouched: true });
    expect(view.status === "ready" && [...view.cells]).toEqual(["collections:posts#read"]);
    expect(model.stored.issues.map(({ message }) => message)).toEqual([
      '"collections:ghost" is not managed by the roles plugin.',
      'Action "publish" does not apply to "collections:posts".',
      "Unknown action; expected one of read, create, update, delete, trash, publish, unpublish, readVersions, unlock.",
    ]);
    if (view.status !== "ready") {
      return;
    }
    const { value } = applyOp(model, view.cells, { type: "clean" });
    await as(payload, users.super).update({
      collection: "roles",
      id,
      data: { permissions: value },
    });
    expect(await storedPermissions(payload, id)).toEqual({
      collections: { posts: { actions: ["read"] } },
      globals: {},
    });
  });
});

test("a failed save's errors land on the row they name", async () => {
  const { payload } = context;
  const model = await modelFor(context, users.editor, roles.blank);
  const permissions = {
    collections: { ghost: { actions: ["read"] }, pages: { actions: ["read", "update", "delete"] } },
  };
  const response = await rest(context, await login(payload, users.editor.email))(
    "PATCH",
    `/roles/${String(roles.blank)}`,
    { permissions },
  );
  expect(response.status).toBe(400);
  const [error] = Array.isArray(response.json?.errors) ? response.json.errors : [];
  const data: unknown = isRecord(error) ? error.data : undefined;
  const errors: unknown[] = isRecord(data) && Array.isArray(data.errors) ? data.errors : [];
  // Payload's ADD_SERVER_ERRORS adds one form-state entry per error path.
  const fields = Object.fromEntries([
    ["permissions", { value: permissions }],
    ...errors.flatMap((entry) =>
      isRecord(entry) && typeof entry.path === "string" && typeof entry.message === "string"
        ? [[entry.path, { errorMessage: entry.message, value: null }]]
        : [],
    ),
  ]);
  const { issues, remove } = takeServerIssues(fields, "permissions");
  expect(remove).not.toContain("permissions");
  const placed = placeServerIssues(model, issues);
  expect([...placed.byRow]).toEqual([
    [
      "collections:pages",
      ['You cannot grant action "delete" on "collections:pages" because you do not hold it.'],
    ],
  ]);
  expect(placed.field).toEqual(['"collections:ghost" is not managed by the roles plugin.']);
});
