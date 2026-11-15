import { expect, test } from "vitest";

import type { Capabilities, Grants } from "../../../src/contract.ts";
import { checkPermissions, describeCellIssue, grantsOf } from "../../../src/grants.ts";
import {
  decideRoleDelete,
  decideRoleWrite,
  decideUserDelete,
  decideUserWrite,
  type UserTarget,
} from "../../../src/guards.ts";
import { buildRegistry } from "../../../src/registry.ts";

const fields = { rolesField: "roles", superAdminField: "superAdmin" };
const pagesRead = grantsOf(["collections:pages#read"]);
const pagesWrite = grantsOf(["collections:pages#read", "collections:pages#update"]);
const roleGrants = new Map<string, Grants>([
  ["1", pagesRead],
  ["2", pagesWrite],
]);
const editorOf = (grants: Grants): Capabilities => ({ kind: "grants", grants });
const ALL: Capabilities = { kind: "all" };

const target = (overrides: Partial<UserTarget> = {}): UserTarget => ({
  capabilities: editorOf(pagesRead),
  doc: { email: "t@example.com", id: 20, roles: [1], superAdmin: false },
  id: 20,
  roleIds: [1],
  superAdmin: false,
  trashed: false,
  ...overrides,
});

const write = (input: Partial<Parameters<typeof decideUserWrite>[0]>) =>
  decideUserWrite({
    editor: editorOf(pagesWrite),
    editorId: 10,
    fields,
    raw: {},
    roleGrants,
    superAdminCount: 1,
    target: null,
    ...input,
  });

test("superAdmin can only be changed by a super admin, and never off the last one", () => {
  expect(write({ raw: { superAdmin: true } })).toEqual({
    kind: "forbidden",
    reason: "super-admin-field",
  });
  expect(write({ editor: ALL, raw: { superAdmin: true } })).toEqual({ kind: "allow" });
  expect(write({ raw: { superAdmin: false }, target: target() })).toEqual({ kind: "allow" });
  expect(
    write({ editor: ALL, raw: { superAdmin: false }, target: target({ superAdmin: true }) }),
  ).toEqual({
    kind: "forbidden",
    reason: "last-super-admin",
  });
  expect(
    write({
      editor: ALL,
      raw: { superAdmin: false },
      target: target({ superAdmin: true, trashed: true }),
    }),
  ).toEqual({ kind: "allow" });
  expect(
    write({
      editor: ALL,
      raw: { superAdmin: false },
      superAdminCount: 2,
      target: target({ superAdmin: true }),
    }),
  ).toEqual({ kind: "allow" });
  expect(
    write({
      editor: ALL,
      raw: { deletedAt: "2026-01-01" },
      superAdminCount: 1,
      target: target({ superAdmin: true }),
    }),
  ).toEqual({ kind: "forbidden", reason: "last-super-admin" });
});

test("role assignment must be covered by the editor and never target the editor themselves", () => {
  expect(write({ raw: { roles: [1] } })).toEqual({ kind: "allow" });
  expect(write({ raw: { roles: ["1", 2] }, target: target() })).toEqual({ kind: "allow" });
  expect(write({ raw: { roles: null }, target: target() })).toEqual({ kind: "allow" });
  expect(write({ raw: { roles: [{ id: 1 }] }, target: target() })).toMatchObject({
    errors: [{ path: "roles" }],
    kind: "invalid",
  });
  expect(write({ raw: { roles: 1 } })).toMatchObject({
    errors: [{ path: "roles" }],
    kind: "invalid",
  });
  expect(write({ raw: { superAdmin: "true" } })).toMatchObject({
    errors: [{ path: "superAdmin" }],
    kind: "invalid",
  });
  expect(write({ raw: { roles: [99] } })).toEqual({ kind: "forbidden", reason: "unknown-role" });
  expect(write({ editor: editorOf(pagesRead), raw: { roles: [2] } })).toEqual({
    kind: "forbidden",
    reason: "role-not-covered",
  });
  expect(
    write({ editor: editorOf(pagesRead), raw: { roles: [] }, target: target({ roleIds: [2] }) }),
  ).toEqual({
    kind: "forbidden",
    reason: "role-not-covered",
  });
  expect(write({ editorId: 20, raw: { roles: [1, 2] }, target: target() })).toEqual({
    kind: "forbidden",
    reason: "own-roles",
  });
  expect(write({ editor: ALL, editorId: 20, raw: { roles: [1, 2] }, target: target() })).toEqual({
    kind: "allow",
  });
});

test("credential changes on another user compare by value and respect the target's standing", () => {
  expect(write({ raw: { email: "t@example.com" }, target: target() })).toEqual({ kind: "allow" });
  expect(write({ raw: { email: "new@example.com" }, target: target() })).toEqual({ kind: "allow" });
  expect(write({ raw: { password: "" }, target: target() })).toEqual({ kind: "allow" });
  expect(
    write({ raw: { password: "x" }, target: target({ capabilities: editorOf(pagesWrite) }) }),
  ).toEqual({
    kind: "allow",
  });
  expect(
    write({
      raw: { password: "x" },
      target: target({ capabilities: editorOf(grantsOf(["collections:posts#read"])) }),
    }),
  ).toEqual({ kind: "forbidden", reason: "target-not-covered" });
  expect(
    write({ raw: { email: "new@example.com" }, target: target({ superAdmin: true }) }),
  ).toEqual({
    kind: "forbidden",
    reason: "target-super-admin",
  });
  expect(
    write({ editorId: 20, raw: { password: "mine" }, target: target({ superAdmin: true }) }),
  ).toEqual({
    kind: "allow",
  });
  expect(write({ raw: { deletedAt: null }, target: target({ superAdmin: true }) })).toEqual({
    kind: "allow",
  });
  expect(
    write({
      raw: { deletedAt: "2026-01-01" },
      superAdminCount: 2,
      target: target({ superAdmin: true }),
    }),
  ).toEqual({
    kind: "forbidden",
    reason: "target-super-admin",
  });
});

test("deletes never remove the last super admin and need the editor to cover the target", () => {
  const admin = target({ capabilities: ALL, superAdmin: true });
  expect(decideUserDelete({ editor: ALL, superAdminCount: 1, target: admin })).toEqual({
    kind: "forbidden",
    reason: "last-super-admin",
  });
  expect(
    decideUserDelete({
      editor: ALL,
      superAdminCount: 1,
      target: target({ capabilities: ALL, superAdmin: true, trashed: true }),
    }),
  ).toEqual({ kind: "allow" });
  expect(decideUserDelete({ editor: ALL, superAdminCount: 2, target: admin })).toEqual({
    kind: "allow",
  });
  expect(
    decideUserDelete({ editor: editorOf(pagesWrite), superAdminCount: 2, target: admin }),
  ).toEqual({
    kind: "forbidden",
    reason: "target-super-admin",
  });
  expect(
    decideUserDelete({
      editor: editorOf(pagesRead),
      superAdminCount: 1,
      target: target({ capabilities: editorOf(pagesWrite) }),
    }),
  ).toEqual({
    kind: "forbidden",
    reason: "target-not-covered",
  });
  expect(
    decideUserDelete({ editor: editorOf(pagesWrite), superAdminCount: 1, target: target() }),
  ).toEqual({ kind: "allow" });
});

test("role writes validate permissions against the editor and freeze the key", () => {
  const registry = buildRegistry(
    { collections: [{ slug: "pages" }, { slug: "roles" }], globals: [] },
    { collections: ["pages"], globals: [], rolesSlug: "roles" },
  );
  const base = {
    current: null,
    editor: editorOf(pagesWrite),
    permissionsField: "permissions" as const,
    registry,
  };

  const ok = decideRoleWrite({
    ...base,
    raw: { permissions: { collections: { pages: { actions: ["update", "read"] } } } },
    targetKey: null,
  });
  expect(ok.decision).toEqual({ kind: "allow" });
  expect(ok.canonical).toEqual({
    collections: { pages: { actions: ["read", "update"] } },
    globals: {},
  });

  const denied = decideRoleWrite({
    ...base,
    raw: { permissions: { collections: { pages: { actions: ["delete"] } } } },
    targetKey: null,
  });
  expect(denied.decision).toMatchObject({
    errors: [
      {
        message: expect.stringContaining(
          'permissions.collections.pages.actions: You cannot grant action "delete"',
        ),
        path: "permissions",
      },
    ],
    kind: "invalid",
  });

  expect(
    decideRoleWrite({ ...base, raw: { key: "renamed" }, targetKey: "original" }).decision,
  ).toMatchObject({
    errors: [{ path: "key" }],
    kind: "invalid",
  });
  expect(
    decideRoleWrite({ ...base, raw: { key: "original" }, targetKey: "original" }).decision,
  ).toEqual({ kind: "allow" });
  expect(decideRoleWrite({ ...base, raw: { key: "fresh" }, targetKey: null }).decision).toEqual({
    kind: "allow",
  });
});

test("role edits and deletes need the editor to cover the role's current grants", () => {
  const registry = buildRegistry(
    { collections: [{ slug: "pages" }, { slug: "roles" }], globals: [] },
    { collections: ["pages"], globals: [], rolesSlug: "roles" },
  );
  const shrink = (editor: Capabilities, current: Grants) =>
    decideRoleWrite({
      current,
      editor,
      permissionsField: "permissions",
      raw: { permissions: { collections: { pages: { actions: ["read"] } } } },
      registry,
      targetKey: "role",
    }).decision;

  expect(shrink(editorOf(pagesRead), pagesWrite)).toEqual({
    kind: "forbidden",
    reason: "role-not-covered",
  });
  expect(shrink(editorOf(pagesRead), pagesRead)).toEqual({ kind: "allow" });
  expect(shrink(ALL, pagesWrite)).toEqual({ kind: "allow" });

  expect(decideRoleDelete(editorOf(pagesRead), pagesWrite)).toEqual({
    kind: "forbidden",
    reason: "role-not-covered",
  });
  expect(decideRoleDelete(editorOf(pagesWrite), pagesWrite)).toEqual({ kind: "allow" });
  expect(decideRoleDelete(ALL, pagesWrite)).toEqual({ kind: "allow" });
});

test("role permission refusals arrive as one permissions error, one line per cell in check order", () => {
  const registry = buildRegistry(
    { collections: [{ slug: "pages" }, { slug: "roles" }], globals: [] },
    { collections: ["pages"], globals: [], rolesSlug: "roles" },
  );
  const editor = editorOf(pagesWrite);
  const permissions = {
    collections: { nothing: { actions: ["read"] }, pages: { actions: ["delete", "publish"] } },
  };
  const { issues } = checkPermissions(permissions, registry, editor);
  expect(issues.length).toBeGreaterThan(1);

  const { decision } = decideRoleWrite({
    current: null,
    editor,
    permissionsField: "permissions",
    raw: { permissions },
    registry,
    targetKey: null,
  });

  expect(decision).toEqual({
    kind: "invalid",
    errors: [
      {
        message: issues.map((issue) => `${issue.path}: ${describeCellIssue(issue)}`).join("\n"),
        path: "permissions",
      },
    ],
  });
});
