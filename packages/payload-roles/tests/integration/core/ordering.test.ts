// Review round 3: the guards decide after Payload's own access check and query validation, one
// document at a time, against the target's stored row. The plugin never runs a client's `where`,
// never reads the target through `afterRead` hooks, and never answers before Payload does.
import type { Plugin } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let users: Record<"deleter" | "editor" | "superAdmin" | "target", Actor>;

/** A common privacy hook: a non-super-admin does not see another user's roles. */
const hideRolesFromOthers: Plugin = (config) => {
  const usersCollection = config.collections?.find((collection) => collection.slug === "users");
  if (usersCollection) {
    usersCollection.hooks = {
      ...usersCollection.hooks,
      afterRead: [
        ...(usersCollection.hooks?.afterRead ?? []),
        ({ doc, req }) => {
          const viewer: unknown = req.user;
          const isOther =
            typeof viewer === "object" &&
            viewer !== null &&
            "id" in viewer &&
            "superAdmin" in viewer &&
            viewer.superAdmin !== true &&
            String(viewer.id) !== String(doc.id);
          if (!isOther) {
            return doc;
          }
          const { roles: _roles, ...visible } = doc;
          return visible;
        },
      ],
    };
  }
  return config;
};
hideRolesFromOthers.order = Number.MAX_SAFE_INTEGER;

beforeAll(async () => {
  context = await createTestPayload({ name: "ordering", plugins: [hideRolesFromOthers] });
  const { payload } = context;
  const superAdmin = await seedUser(payload, { email: "super@example.com" });
  const pagesWriter = await seedRole(payload, "pages-writer", {
    collections: { pages: { actions: ["read", "create", "update", "delete"] } },
  });
  const usersDeleter = await seedRole(payload, "users-deleter", {
    collections: { pages: { actions: ["read"] }, users: { actions: ["read", "delete"] } },
  });
  const usersEditor = await seedRole(payload, "users-editor", {
    collections: { pages: { actions: ["read"] }, users: { actions: ["read", "update"] } },
  });
  users = {
    deleter: await seedUser(payload, { email: "deleter@example.com", roles: [usersDeleter] }),
    editor: await seedUser(payload, { email: "editor@example.com", roles: [usersEditor] }),
    superAdmin,
    target: await seedUser(payload, { email: "target@example.com", roles: [pagesWriter] }),
  };
});

afterAll(() => context.destroy());

const superAdminIds = async () =>
  (
    await context.payload.find({
      collection: "users",
      depth: 0,
      limit: 0,
      pagination: false,
      where: { superAdmin: { equals: true } },
    })
  ).docs.map((doc) => doc.id);

const errorCount = (json: Record<string, unknown> | null) =>
  Array.isArray(json?.errors) ? json.errors.length : null;

const byString = (a: number | string, b: number | string) => String(a).localeCompare(String(b));

test("a bulk delete filtered on a hidden field gets Payload's query error whether or not the filter matches", async () => {
  const { payload } = context;
  const anonymous = rest(context, null);
  const forgot = await anonymous("POST", "/users/forgot-password", {
    email: users.superAdmin.email,
  });
  expect(forgot.status).toBe(200);
  const row = await payload.db.findOne<{ id: number | string; resetPasswordToken?: unknown }>({
    collection: "users",
    where: { id: { equals: users.superAdmin.id } },
  });
  const token = row?.resetPasswordToken;
  if (typeof token !== "string") {
    throw new TypeError("forgot-password stored no token");
  }

  const deleter = rest(context, await login(payload, users.deleter.email));
  const probe = (prefix: string) =>
    deleter(
      "DELETE",
      `/users?where[and][0][email][equals]=${users.superAdmin.email}&where[and][1][resetPasswordToken][like]=${prefix}`,
    );
  const matching = await probe(token.slice(0, 4));
  const wrong = await probe("zzzz");
  const read = await deleter("GET", `/users?where[resetPasswordToken][like]=${token.slice(0, 4)}`);

  expect(matching.status).toBe(wrong.status);
  expect(matching.status).toBe(read.status);
  expect(read.status).toBe(400);
  expect(await superAdminIds()).toEqual([users.superAdmin.id]);

  const reset = await anonymous("POST", "/users/reset-password", {
    password: "after the reset",
    token,
  });
  expect(reset.status).toBe(200);
  await login(payload, users.superAdmin.email, "after the reset");
  await payload.update({
    collection: "users",
    data: { password: PASSWORD },
    id: users.superAdmin.id,
  });
});

test("an afterRead hook that hides a target's roles does not weaken the target for the guard", async () => {
  const { payload } = context;
  const editor = rest(context, await login(payload, users.editor.email));

  const seen = await editor("GET", `/users/${users.target.id}`);
  expect(seen.status).toBe(200);
  expect(seen.json).not.toHaveProperty("roles");

  const takeover = await editor("PATCH", `/users/${users.target.id}`, {
    password: "attacker password",
  });
  expect(takeover.status).toBe(403);
  await expect(login(payload, users.target.email, "attacker password")).rejects.toMatchObject({
    name: "AuthenticationError",
  });
  await login(payload, users.target.email, PASSWORD);
});

test("anonymous writes get Payload's access answer and never a guard answer", async () => {
  const { payload } = context;
  const anonymous = rest(context, null);
  const role = await payload.create({
    collection: "roles",
    data: {
      key: "shrunk",
      name: "shrunk",
      permissions: { collections: { pages: { actions: ["read"] } } },
    },
  });
  await payload.update({ collection: "roles", data: { permissions: {} }, id: role.id });
  const { docs } = await payload.findVersions({
    collection: "roles",
    depth: 0,
    where: { parent: { equals: role.id } },
  });
  const grantingVersion: unknown = docs.find((doc) =>
    JSON.stringify(doc.version.permissions).includes("read"),
  )?.id;
  const usersBefore = await payload.count({ collection: "users" });
  const logsBefore = context.logs.length;

  const responses = await Promise.all([
    anonymous("DELETE", "/users?where[id][exists]=true"),
    anonymous("PATCH", `/users/${users.target.id}`, { password: "anonymous password" }),
    anonymous("POST", `/roles/versions/${String(grantingVersion)}`),
    anonymous("PATCH", `/roles/${role.id}`, { key: "guess" }),
    anonymous("PATCH", "/roles?where[id][exists]=true", { key: "guess" }),
    anonymous("DELETE", `/roles/${role.id}`),
  ]);

  expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
  expect(responses.map((response) => JSON.stringify(response.json)).join("\n")).not.toMatch(
    /permissions|key|super/u,
  );
  expect(context.logs.slice(logsBefore).filter((line) => line.event === "guard_denied")).toEqual(
    [],
  );
  expect(await payload.count({ collection: "users" })).toEqual(usersBefore);
  expect(
    (await payload.findByID({ collection: "roles", depth: 0, id: role.id })).permissions,
  ).toEqual({});
});

test("a bulk demotion or delete of every super admin is refused for the last one only", async () => {
  const { payload } = context;
  const extra = await Promise.all(
    ["second", "third"].map((name) =>
      seedUser(payload, { email: `${name}-admin@example.com`, superAdmin: true }),
    ),
  );
  const everyAdmin = [users.superAdmin, ...extra].map((user) => user.id);
  expect((await superAdminIds()).toSorted(byString)).toEqual(everyAdmin.toSorted(byString));
  const admin = rest(context, await login(payload, users.superAdmin.email));

  const demotion = await admin("PATCH", "/users?where[superAdmin][equals]=true", {
    superAdmin: false,
  });
  expect(demotion.status).toBe(400);
  expect(errorCount(demotion.json)).toBe(1);
  expect(await superAdminIds()).toHaveLength(1);

  await Promise.all(
    everyAdmin.map((id) => payload.update({ collection: "users", data: { superAdmin: true }, id })),
  );
  const deletion = await admin("DELETE", "/users?where[superAdmin][equals]=true");
  expect(deletion.status).toBe(400);
  expect(errorCount(deletion.json)).toBe(1);
  expect(await superAdminIds()).toHaveLength(1);
});
