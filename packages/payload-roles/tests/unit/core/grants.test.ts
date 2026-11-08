import { expect, test } from "vitest";

import {
  can,
  checkPermissions,
  covers,
  grantsOf,
  missingFrom,
  parsePermissions,
  serializePermissions,
  unionGrants,
} from "../../../src/grants.ts";
import { buildRegistry } from "../../../src/registry.ts";

const registry = buildRegistry(
  {
    collections: [
      { auth: true, slug: "users" },
      { slug: "pages", trash: true, versions: { drafts: true } },
      { slug: "posts" },
      { slug: "roles" },
    ],
    globals: [{ slug: "settings" }],
  },
  { collections: ["users", "pages", "posts"], globals: ["settings"], rolesSlug: "roles" },
);

test("valid cells parse into grants and nothing else", () => {
  const { grants, issues } = parsePermissions(
    {
      collections: { pages: { actions: ["read", "publish"] } },
      globals: { settings: { actions: ["update"] } },
    },
    registry,
  );
  expect([...grants].toSorted()).toEqual([
    "collections:pages#publish",
    "collections:pages#read",
    "globals:settings#update",
  ]);
  expect(issues).toEqual([]);
});

test("malformed, unknown and inapplicable cells are dropped with a path each", () => {
  const { grants, issues } = parsePermissions(
    {
      collections: {
        pages: { actions: ["read", "fly"] },
        posts: { actions: ["publish"] },
        missing: { actions: ["read"] },
        bad: "read",
        extra: { actions: ["read"], fields: [] },
      },
      globals: [],
      other: {},
    },
    registry,
  );
  expect([...grants]).toEqual(["collections:pages#read"]);
  expect(issues.map((issue) => `${issue.path}:${issue.reason}`).toSorted()).toEqual([
    "permissions.collections.bad:malformed",
    "permissions.collections.extra:malformed",
    "permissions.collections.missing.actions:unknown-resource",
    "permissions.collections.pages.actions:unknown-action",
    "permissions.collections.posts.actions:inapplicable",
    "permissions.globals:malformed",
    "permissions.other:malformed",
  ]);
});

test("non-object permissions grant nothing", () => {
  expect(parsePermissions("read everything", registry)).toMatchObject({
    issues: [{ path: "permissions", reason: "malformed" }],
  });
  expect([...parsePermissions(null, registry).grants]).toEqual([]);
  expect([...parsePermissions(undefined, registry).grants]).toEqual([]);
});

test("the write boundary adds requires-update and not-held issues", () => {
  const editor = grantsOf(["collections:pages#read", "collections:pages#update"]);
  const { issues } = checkPermissions(
    { collections: { pages: { actions: ["publish", "read"] }, posts: { actions: ["read"] } } },
    registry,
    { kind: "grants", grants: editor },
  );
  expect(issues.map((issue) => `${issue.action}:${issue.reason}`).toSorted()).toEqual([
    "publish:not-held",
    "publish:requires-update",
    "read:not-held",
  ]);
  expect(
    checkPermissions({ collections: { pages: { actions: ["publish"] } } }, registry, {
      kind: "all",
    }).issues,
  ).toEqual([expect.objectContaining({ action: "publish", reason: "requires-update" })]);
});

test("serialization is canonical: registry order, action order, no duplicates, applicable only", () => {
  const grants = grantsOf([
    "globals:settings#update",
    "collections:pages#publish",
    "collections:pages#read",
    "collections:pages#read",
    "collections:users#trash",
  ]);
  expect(serializePermissions(grants, registry)).toEqual({
    collections: { pages: { actions: ["read", "publish"] } },
    globals: { settings: { actions: ["update"] } },
  });
});

test("union, can, missingFrom and covers agree with set semantics", () => {
  const a = grantsOf(["collections:pages#read"]);
  const b = grantsOf(["collections:posts#read", "collections:pages#read"]);
  const union = unionGrants([a, b]);
  expect(union.size).toBe(2);
  expect(can({ kind: "grants", grants: union }, "collections:posts", "read")).toBe(true);
  expect(can({ kind: "grants", grants: a }, "collections:posts", "read")).toBe(false);
  expect(can({ kind: "all" }, "collections:posts", "delete")).toBe(true);
  expect(missingFrom(b, { kind: "grants", grants: a })).toEqual(["collections:posts#read"]);
  expect(covers({ kind: "grants", grants: b }, { kind: "grants", grants: a })).toBe(true);
  expect(covers({ kind: "grants", grants: b }, { kind: "all" })).toBe(false);
  expect(covers({ kind: "all" }, { kind: "all" })).toBe(true);
});
