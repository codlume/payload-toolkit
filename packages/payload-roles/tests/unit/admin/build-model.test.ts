import { describe, expect, expectTypeOf, test } from "vitest";

import type * as Contract from "../../../src/contract.ts";
import { NO_CAPABILITIES } from "../../../src/grants.ts";
import { buildRegistry } from "../../../src/registry.ts";
import type * as Model from "../../../src/admin/model.ts";
import { ALL, holding, modelOf } from "./fixture.ts";

const modesOf = (model: Model.MatrixModel) =>
  Object.fromEntries(model.rows.map((row) => [row.id, row.cells]));

const DISABLED = { enabled: false, rolesSlug: "roles", userCollection: "users" };

test("the wire model's grant types are the contract's", () => {
  expectTypeOf<Model.ActionId>().toEqualTypeOf<Contract.ActionId>();
  expectTypeOf<Model.ResourceId>().toEqualTypeOf<Contract.ResourceId>();
  expectTypeOf<Model.Grant>().toEqualTypeOf<Contract.Grant>();
});

describe("rows and columns", () => {
  test("columns are the applicable actions in contract order, with human labels", () => {
    const registry = buildRegistry(
      { collections: [{ slug: "posts" }, { slug: "roles", versions: true }] },
      { collections: ["posts"], globals: [], rolesSlug: "roles" },
    );
    const model = modelOf({ registry });
    expect(model.columns).toEqual([
      { action: "read", label: "Read" },
      { action: "create", label: "Create" },
      { action: "update", label: "Update" },
      { action: "delete", label: "Delete" },
      { action: "readVersions", label: "Versions" },
    ]);
    expect(Object.keys(modesOf(model)["collections:posts"] ?? {})).toEqual([
      "read",
      "create",
      "update",
      "delete",
    ]);
  });

  test("rows carry their error path and a label that falls back to the slug", () => {
    const model = modelOf({ labels: new Map([["collections:pages", "Web pages"]]) });
    expect(model.rows.map(({ id, kind, label, path }) => ({ id, kind, label, path }))).toEqual([
      {
        id: "collections:users",
        kind: "collections",
        label: "users",
        path: "permissions.collections.users.actions",
      },
      {
        id: "collections:pages",
        kind: "collections",
        label: "Web pages",
        path: "permissions.collections.pages.actions",
      },
      {
        id: "collections:posts",
        kind: "collections",
        label: "posts",
        path: "permissions.collections.posts.actions",
      },
      {
        id: "collections:roles",
        kind: "collections",
        label: "roles",
        path: "permissions.collections.roles.actions",
      },
      {
        id: "globals:settings",
        kind: "globals",
        label: "settings",
        path: "permissions.globals.settings.actions",
      },
    ]);
  });
});

describe("cell modes", () => {
  test("a super admin can grant every applicable cell", () => {
    const model = modelOf({ editor: ALL });
    expect(model.lock).toBeNull();
    for (const row of model.rows) {
      expect(new Set(Object.values(row.cells))).toEqual(new Set(["grantable"]));
    }
  });

  test("a member can grant exactly what they hold, and publish only with update", () => {
    const model = modelOf({
      editor: holding(
        "collections:pages#read",
        "collections:pages#publish",
        "globals:settings#update",
        "globals:settings#publish",
      ),
    });
    expect(modesOf(model)["collections:pages"]).toEqual({
      read: "grantable",
      create: "fixed",
      update: "fixed",
      delete: "fixed",
      trash: "fixed",
      publish: "fixed",
      unpublish: "fixed",
      readVersions: "fixed",
    });
    expect(modesOf(model)["globals:settings"]).toEqual({
      read: "fixed",
      update: "grantable",
      publish: "grantable",
      unpublish: "fixed",
      readVersions: "fixed",
    });
  });

  test("an outsider can grant nothing", () => {
    const model = modelOf({ editor: NO_CAPABILITIES });
    expect(model.rows.flatMap((row) => Object.values(row.cells))).not.toContain("grantable");
  });

  test("read-only fixes every cell, even in disabled mode", () => {
    for (const model of [
      modelOf({ readOnly: true }),
      modelOf({ readOnly: true, options: DISABLED }),
    ]) {
      expect(model.lock).toEqual({ kind: "read-only" });
      expect(model.rows.flatMap((row) => Object.values(row.cells))).not.toContain("grantable");
    }
  });

  test("a stored role the editor does not cover is locked and names the missing cells", () => {
    const editor = holding("collections:pages#read", "collections:roles#update");
    const value = {
      collections: { pages: { actions: ["read", "delete"] }, posts: { actions: ["read"] } },
    };
    const model = modelOf({ editor, value });
    expect(model.lock).toEqual({
      kind: "not-covered",
      missing: ["collections:pages#delete", "collections:posts#read"],
    });
    expect(model.rows.flatMap((row) => Object.values(row.cells))).not.toContain("grantable");
    expect(modelOf({ editor, value, existing: false }).lock).toBeNull();
  });

  test("disabled mode can grant every applicable cell and says it is not enforced", () => {
    const model = modelOf({
      editor: NO_CAPABILITIES,
      options: DISABLED,
      value: { collections: { pages: { actions: ["read"] } } },
    });
    expect(model.enforced).toBe(false);
    expect(model.lock).toBeNull();
    expect(model.rows.flatMap((row) => Object.values(row.cells))).not.toContain("fixed");
  });
});

describe("the stored reading", () => {
  test("holds the parse, its fingerprint and every issue the next write would drop", () => {
    const value = {
      collections: {
        pages: { actions: ["read", "publish", "bogus"] },
        ghost: { actions: ["read"] },
      },
      extra: true,
    };
    const { stored } = modelOf({ value });
    expect(stored.fingerprint).toBe(JSON.stringify(value));
    expect(stored.granted.toSorted()).toEqual([
      "collections:pages#publish",
      "collections:pages#read",
    ]);
    expect(stored.issues).toEqual([
      { row: null, message: expect.stringContaining("Permissions must be") },
      { row: "collections:pages", message: expect.stringContaining("Unknown action") },
      { row: null, message: '"collections:ghost" is not managed by the roles plugin.' },
      {
        row: "collections:pages",
        message: 'Action "publish" requires "update" on the same resource.',
      },
    ]);
  });

  test("an absent value reads as empty", () => {
    expect(modelOf({ value: undefined }).stored).toEqual({
      fingerprint: "null",
      granted: [],
      issues: [],
    });
  });
});

test("the picker check names users write cells and roles read, or nothing when users is unmanaged", () => {
  expect(modelOf().pickerCheck).toEqual({
    assigns: ["collections:users#update", "collections:users#create"],
    needs: "collections:roles#read",
  });
  expect(
    modelOf({ options: { enabled: true, rolesSlug: "roles", userCollection: "members" } })
      .pickerCheck,
  ).toBeNull();
});
