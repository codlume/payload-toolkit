import type { CollectionConfig } from "payload";
import { expect, test } from "vitest";

import { resolveOptions } from "../../../src/options.ts";

const config = (): Parameters<typeof resolveOptions>[0] => ({
  collections: [
    { auth: true, fields: [{ name: "team", type: "text" }], slug: "users" },
    { fields: [], slug: "pages", versions: { drafts: { localizeStatus: true } } },
    { fields: [], slug: "posts" },
    { auth: true, fields: [], slug: "customers" },
  ],
  globals: [{ fields: [], slug: "settings" }],
});

test("defaults follow Payload's admin user collection and the documented names", () => {
  const { options, problems } = resolveOptions(config(), { collections: ["posts"] });
  expect(problems).toEqual([]);
  expect(options).toEqual({
    claimField: "rolesBootstrapClaim",
    collections: ["posts"],
    debug: false,
    enabled: true,
    globals: [],
    permissionsField: "permissions",
    rolesField: "roles",
    rolesSlug: "roles",
    superAdminField: "superAdmin",
    userCollection: "users",
  });
  expect(
    resolveOptions({ ...config(), admin: { user: "customers" } }, { collections: ["posts"] })
      .options.userCollection,
  ).toBe("customers");
});

test("every configuration problem is reported in one pass", () => {
  const { problems } = resolveOptions(config(), {
    collections: ["pages", "posts", "posts", "missing", "payload-jobs"],
    globals: ["nope"],
    rolesField: "team",
    rolesSlug: "posts",
    superAdminField: "email",
    userCollection: "pages",
  });
  expect(problems.toSorted()).toEqual(
    [
      'Collection "missing" does not exist.',
      'Collection "pages" uses `versions.drafts.localizeStatus`, which the roles plugin does not support.',
      'Collection "payload-jobs" is a Payload system collection and cannot be managed.',
      'Global "nope" does not exist.',
      'User collection "pages" must be auth-enabled.',
      '`collections` must not contain duplicate slug "posts".',
      '`rolesSlug` "posts" is already a collection; choose another slug.',
    ].toSorted(),
  );

  const { problems: fieldProblems } = resolveOptions(config(), {
    collections: ["posts"],
    rolesField: "team",
    superAdminField: "email",
  });
  expect(fieldProblems.toSorted()).toEqual([
    'Collection "users" already has a top-level field named "team".',
    'Field "email" on "users" is reserved by Payload.',
  ]);
});

test("the field Payload adds for a forgot-password interval is reserved", () => {
  const { problems } = resolveOptions(config(), {
    collections: ["posts"],
    superAdminField: "resetPasswordRequestedAt",
  });
  expect(problems).toEqual(['Field "resetPasswordRequestedAt" on "users" is reserved by Payload.']);
});

test("no managed target and an unsafe field name are rejected", () => {
  const { problems } = resolveOptions(config(), { rolesField: "1-bad" });
  expect(problems).toEqual([
    '`rolesField` "1-bad" must start with a letter and contain only letters, numbers, or underscores.',
    "Configure at least one managed target with `collections` or `globals`.",
  ]);
});

test("a user collection with drafts is rejected, while plain versions are allowed", () => {
  const withUsers = (versions: NonNullable<CollectionConfig["versions"]>) => ({
    ...config(),
    collections: [
      { auth: true, fields: [], slug: "users", versions },
      { fields: [], slug: "posts" },
    ],
  });
  const problem =
    'User collection "users" uses `versions.drafts`, which the roles plugin does not support.';

  expect(resolveOptions(withUsers({ drafts: true }), { collections: ["posts"] }).problems).toEqual([
    problem,
  ]);
  expect(
    resolveOptions(withUsers({ drafts: { autosave: true } }), { collections: ["posts"] }).problems,
  ).toEqual([problem]);
  expect(resolveOptions(withUsers(true), { collections: ["posts"] }).problems).toEqual([]);
  expect(
    resolveOptions(withUsers({ drafts: false, maxPerDoc: 5 }), { collections: ["posts"] }).problems,
  ).toEqual([]);
});
