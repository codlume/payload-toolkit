import { expect, test } from "vitest";

import type { ResourceId } from "../../../src/contract.ts";
import { buildRegistry, describeRegistryDrift } from "../../../src/registry.ts";

const options = {
  collections: ["users", "pages", "posts"],
  globals: ["settings"],
  rolesSlug: "roles",
};

const source = {
  collections: [
    { auth: true, slug: "users" },
    { slug: "pages", trash: true, versions: { drafts: true } },
    { slug: "posts", versions: true },
    { slug: "roles", versions: true },
    { slug: "unmanaged", versions: { drafts: true } },
    { auth: { maxLoginAttempts: 0 }, slug: "bots" },
  ],
  globals: [{ slug: "settings", versions: { drafts: true } }, { slug: "footer" }],
};

const actionsOf = (id: ResourceId) => [...(buildRegistry(source, options).get(id)?.actions ?? [])];

test("applicable actions follow the config shape of each managed resource", () => {
  expect(actionsOf("collections:users")).toEqual(["read", "create", "update", "delete", "unlock"]);
  expect(actionsOf("collections:pages")).toEqual([
    "read",
    "create",
    "update",
    "delete",
    "trash",
    "publish",
    "unpublish",
    "readVersions",
  ]);
  expect(actionsOf("collections:posts")).toEqual([
    "read",
    "create",
    "update",
    "delete",
    "readVersions",
  ]);
  expect(actionsOf("globals:settings")).toEqual([
    "read",
    "update",
    "publish",
    "unpublish",
    "readVersions",
  ]);
});

test("the roles collection is always managed and unlisted resources are not", () => {
  const registry = buildRegistry(source, { ...options, collections: ["pages"] });
  expect([...registry.keys()]).toEqual([
    "collections:pages",
    "collections:roles",
    "globals:settings",
  ]);
  expect(actionsOf("collections:roles")).toEqual([
    "read",
    "create",
    "update",
    "delete",
    "readVersions",
  ]);
});

test("an auth collection with maxLoginAttempts 0 has no unlock action", () => {
  const registry = buildRegistry(source, { ...options, collections: ["bots"] });
  expect([...(registry.get("collections:bots")?.actions ?? [])]).toEqual([
    "read",
    "create",
    "update",
    "delete",
  ]);
});

test("drift reports flags that changed and resources that appeared or disappeared", () => {
  const before = buildRegistry(source, options);
  const after = buildRegistry(
    {
      collections: [
        { auth: true, slug: "users" },
        { slug: "pages", trash: false, versions: { drafts: true } },
        { slug: "roles", versions: true },
      ],
      globals: source.globals,
    },
    options,
  );

  const problems = describeRegistryDrift(before, after);
  expect(problems).toHaveLength(2);
  expect(problems.join("\n")).toMatch(/collections:pages.*trash.*true to false/u);
  expect(problems.join("\n")).toMatch(/collections:posts.*missing/u);
  expect(describeRegistryDrift(before, before)).toEqual([]);
});
