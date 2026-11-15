// Finding 2: restoring a version writes the version's values without an update operation, so
// the guards judge the version as the incoming write.
import { createPayloadRequest, type Payload } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  type Actor,
  as,
  fresh,
  login,
  PASSWORD,
  rest,
  seedRole,
  seedUser,
} from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roles: Record<"manager" | "pagesReader" | "pagesWriter" | "usersAdmin", number | string>;
let users: Record<"editor" | "manager", Actor>;

/** The id of the stored version of `parent` whose values satisfy `match`. */
const versionWhere = async (
  payload: Payload,
  collection: string,
  parent: number | string,
  match: (version: Record<string, unknown>) => boolean,
): Promise<string> => {
  const { docs } = await payload.findVersions({
    collection,
    depth: 0,
    limit: 20,
    where: { parent: { equals: parent } },
  });
  const hit = docs.find((doc) => match(doc.version));
  if (!hit) {
    throw new Error(`no version of ${collection} ${String(parent)} matches`);
  }
  // Payload types version ids as strings, but SQL adapters return numbers.
  const id: unknown = hit.id;
  return String(id);
};

beforeAll(async () => {
  const collections = fixtureCollections();
  const usersCollection = collections.find((collection) => collection.slug === "users");
  if (usersCollection) {
    Object.assign(usersCollection, { versions: true });
  }
  context = await createTestPayload({ collections, name: "restore" });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  roles = {
    manager: await seedRole(payload, "manager", {
      collections: {
        pages: { actions: ["read"] },
        roles: { actions: ["read", "update", "readVersions"] },
      },
    }),
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    pagesWriter: await seedRole(payload, "pages-writer", {
      collections: { pages: { actions: ["read", "create", "update", "delete"] } },
    }),
    usersAdmin: await seedRole(payload, "users-admin", {
      collections: {
        pages: { actions: ["read"] },
        roles: { actions: ["read"] },
        users: { actions: ["read", "create", "update", "delete", "readVersions"] },
      },
    }),
  };
  users = {
    editor: await seedUser(payload, { email: "editor@example.com", roles: [roles.usersAdmin] }),
    manager: await seedUser(payload, { email: "manager@example.com", roles: [roles.manager] }),
  };
});

afterAll(() => context.destroy());

test("restoring a role version is checked against the editor's capabilities", async () => {
  const { payload } = context;
  const role = await payload.create({
    collection: "roles",
    data: {
      key: "drift",
      name: "drift",
      permissions: { collections: { pages: { actions: ["read", "delete"] } } },
    },
  });
  await payload.update({
    collection: "roles",
    data: { permissions: { collections: { pages: { actions: ["read"] } } } },
    id: role.id,
  });
  const withDelete = await versionWhere(payload, "roles", role.id, (version) =>
    JSON.stringify(version.permissions).includes("delete"),
  );
  const readOnly = await versionWhere(
    payload,
    "roles",
    role.id,
    (version) => !JSON.stringify(version.permissions).includes("delete"),
  );
  const manager = as(payload, users.manager);

  await rejectsWith(
    manager.restoreVersion({ collection: "roles", id: withDelete }),
    "ValidationError",
  );
  const response = await rest(context, await login(payload, users.manager.email))(
    "POST",
    `/roles/versions/${withDelete}`,
  );
  expect(response.status).toBe(400);
  expect(JSON.stringify(response.json)).toContain("permissions.collections.pages.actions");
  const readOnlyPermissions = { collections: { pages: { actions: ["read"] } } };
  expect(
    (await payload.findByID({ collection: "roles", depth: 0, id: role.id })).permissions,
  ).toEqual(readOnlyPermissions);

  const restored = await manager.restoreVersion({ collection: "roles", id: readOnly });
  expect(restored.permissions).toEqual(readOnlyPermissions);
});

test("restoring a user version is checked like an update of roles and superAdmin", async () => {
  const { payload } = context;
  const victim = await seedUser(payload, {
    email: "victim@example.com",
    roles: [roles.pagesWriter],
  });
  await payload.update({ collection: "users", data: { roles: [] }, id: victim.id });
  const withWriter = await versionWhere(payload, "users", victim.id, (version) =>
    JSON.stringify(version.roles).includes(String(roles.pagesWriter)),
  );
  const demoted = await seedUser(payload, { email: "demoted@example.com", superAdmin: true });
  await payload.update({ collection: "users", data: { superAdmin: false }, id: demoted.id });
  const asSuper = await versionWhere(
    payload,
    "users",
    demoted.id,
    (version) => version.superAdmin === true,
  );
  const editor = as(payload, users.editor);

  await rejectsWith(editor.restoreVersion({ collection: "users", id: withWriter }), "Forbidden");
  expect((await fresh(payload, victim.id)).roles).toEqual([]);
  // Payload's field access removes `superAdmin` from a non-super-admin's restore before the
  // guard sees it, so the restore goes through without the flag.
  await editor.restoreVersion({ collection: "users", id: asSuper });
  expect((await fresh(payload, demoted.id)).superAdmin).toBe(false);

  const noRoles = await versionWhere(
    payload,
    "users",
    victim.id,
    (version) => Array.isArray(version.roles) && version.roles.length === 0,
  );
  const restored = await editor.restoreVersion({ collection: "users", id: noRoles });
  expect(restored.email).toBe(victim.email);
});

test("a restore on an HTTP request with access overridden compares every stored credential", async () => {
  const { payload } = context;
  const victim = await seedUser(payload, {
    email: "credentials@example.com",
    roles: [roles.pagesWriter],
  });
  const peer = await seedUser(payload, { email: "peer@example.com", roles: [roles.pagesReader] });
  await Promise.all(
    [victim, peer].map((user) =>
      payload.update({ collection: "users", data: { password: "rotated password" }, id: user.id }),
    ),
  );
  const original = async (user: Actor) => {
    const { docs } = await payload.findVersions({
      collection: "users",
      depth: 0,
      sort: "createdAt",
      where: { parent: { equals: user.id } },
    });
    const id: unknown = docs[0]?.id;
    return String(id);
  };
  // App code that restores on behalf of an HTTP request: field access does not run, the guard does.
  const restoreAsEditor = async (id: string) =>
    payload.restoreVersion({
      collection: "users",
      id,
      overrideAccess: true,
      req: await createPayloadRequest({
        config: context.config,
        payloadInstanceCacheKey: context.key,
        request: new Request("http://localhost/api/users/versions", {
          headers: { Authorization: `JWT ${await login(payload, users.editor.email)}` },
          method: "POST",
        }),
      }),
    });

  await rejectsWith(restoreAsEditor(await original(victim)), "Forbidden");
  await expect(login(payload, victim.email, PASSWORD)).rejects.toMatchObject({
    name: "AuthenticationError",
  });
  await login(payload, victim.email, "rotated password");

  await restoreAsEditor(await original(peer));
  await login(payload, peer.email, PASSWORD);
});
