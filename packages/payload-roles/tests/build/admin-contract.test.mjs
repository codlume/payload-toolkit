import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const packageURL = new URL("../../", import.meta.url);
const read = (file) => readFile(new URL(file, packageURL), "utf8");

const SERVER_COMPONENTS = ["PermissionsField", "UnpublishControl", "UnpublishSlot"];
const CLIENT_COMPONENTS = ["PermissionsMatrix", "UnpublishDocument"];
const CORE_EXPORTS = ["RolesPluginConfigError", "resolveCapabilities", "rolesPlugin"];

const exportedNames = (source) => {
  const names = [];
  for (const [, list] of source.matchAll(/^export\s*\{([^}]*)\};?\s*$/gmu)) {
    for (const specifier of list.split(",")) {
      const name = specifier.trim().split(/\s+as\s+/u).at(-1);
      if (name) {
        names.push(name);
      }
    }
  }
  return names.sort();
};

const componentPaths = (value, found = new Set()) => {
  if (typeof value === "string") {
    if (value.startsWith("@codlume/payload-roles")) {
      found.add(value);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) {
      componentPaths(item, found);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) {
      componentPaths(item, found);
    }
  }
  return found;
};

const pluginConfig = async () => {
  const { rolesPlugin } = await import("@codlume/payload-roles");
  return rolesPlugin({ collections: ["users", "pages"], globals: ["settings"] })({
    admin: { user: "users" },
    collections: [
      { slug: "users", auth: true, fields: [] },
      { slug: "pages", fields: [{ name: "title", type: "text" }], versions: { drafts: true } },
    ],
    globals: [{ slug: "settings", fields: [], versions: { drafts: true } }],
  });
};

test("dist still holds only the two entries and their declarations", async () => {
  assert.deepEqual((await readdir(new URL("dist/", packageURL))).sort(), [
    "client.d.mts",
    "client.mjs",
    "index.d.mts",
    "index.mjs",
  ]);
});

test("the package root loads in plain Node and exposes the admin server components", async () => {
  const root = await import("@codlume/payload-roles");
  assert.deepEqual(Object.keys(root).sort(), [...CORE_EXPORTS, ...SERVER_COMPONENTS].sort());
  for (const name of SERVER_COMPONENTS) {
    assert.equal(typeof root[name], "function", name);
  }
});

test("the client entry exports exactly the admin client components", async () => {
  assert.deepEqual(exportedNames(await read("dist/client.mjs")), [...CLIENT_COMPONENTS].sort());
});

test("the server entry reaches client code only through lazy imports", async () => {
  const server = await read("dist/index.mjs");
  assert.doesNotMatch(server, /from\s*["']@codlume\/payload-roles\/client["']/u);
  assert.doesNotMatch(server, /from\s*["']@payloadcms\/ui["']/u);
  assert.match(server, /import\(\s*["']@codlume\/payload-roles\/client["']\s*\)/u);
});

test("the client bundle carries no server enforcement code", async () => {
  const client = await read("dist/client.mjs");
  assert.doesNotMatch(client, /from\s*["']\.{1,2}\//u, "no shared chunk import");
  assert.doesNotMatch(client, /from\s*["']payload["']/u);
  for (const marker of [
    "enforcerOf",
    "parsePermissions",
    "checkPermissions",
    "serializePermissions",
    "describeCellIssue",
    "missingFrom",
    "createLocalReq",
    "payload.db",
    "is not registered on this Payload config",
  ]) {
    assert.ok(!client.includes(marker), `client bundle contains ${marker}`);
  }
});

test("every import-map string the plugin emits names a real export", async () => {
  const config = await pluginConfig();
  const paths = [...componentPaths([config.collections, config.globals])].sort();
  assert.deepEqual(paths, [
    "@codlume/payload-roles#PermissionsField",
    "@codlume/payload-roles#UnpublishControl",
    "@codlume/payload-roles#UnpublishSlot",
  ]);
  const root = await import("@codlume/payload-roles");
  const client = exportedNames(await read("dist/client.mjs"));
  for (const path of paths) {
    const [entry, name] = path.split("#");
    if (entry === "@codlume/payload-roles/client") {
      assert.ok(client.includes(name), path);
    } else {
      assert.equal(typeof root[name], "function", path);
    }
  }
});
