import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, fresh, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let roles: Record<"notesAll" | "pagesReader" | "postsWriter" | "settingsReader", number | string>;
let users: Record<"nobody" | "notesUser" | "reader" | "settingsUser" | "union", Actor>;

beforeAll(async () => {
  context = await createTestPayload({ name: "access" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  roles = {
    notesAll: await seedRole(payload, "notes-all", {
      collections: { notes: { actions: ["read", "create", "update", "delete"] } },
    }),
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    postsWriter: await seedRole(payload, "posts-writer", {
      collections: { posts: { actions: ["read", "create", "update", "delete"] } },
    }),
    settingsReader: await seedRole(payload, "settings-reader", {
      globals: { settings: { actions: ["read"] } },
    }),
  };
  users = {
    nobody: await seedUser(payload, { email: "nobody@example.com" }),
    notesUser: await seedUser(payload, { email: "notes@example.com", roles: [roles.notesAll] }),
    reader: await seedUser(payload, { email: "reader@example.com", roles: [roles.pagesReader] }),
    settingsUser: await seedUser(payload, {
      email: "settings@example.com",
      roles: [roles.settingsReader],
    }),
    union: await seedUser(payload, {
      email: "union@example.com",
      roles: [roles.pagesReader, roles.postsWriter],
    }),
  };
  await payload.create({ collection: "pages", data: { title: "Home" } });
  await payload.create({ collection: "posts", data: { title: "Public post" } });
  await payload.create({ collection: "notes", data: { title: "visible" } });
  await payload.create({ collection: "notes", data: { title: "hidden" } });
});

afterAll(() => context.destroy());

test("a user with no roles is denied every managed action while anonymous public reads still work", async () => {
  const nobody = as(context.payload, users.nobody);

  await rejectsWith(nobody.find({ collection: "pages" }), "Forbidden");
  await rejectsWith(nobody.find({ collection: "posts" }), "Forbidden");
  await rejectsWith(nobody.create({ collection: "posts", data: { title: "x" } }), "Forbidden");
  await rejectsWith(nobody.findGlobal({ slug: "settings" }), "Forbidden");

  const anonymousPosts = await context.payload.find({ collection: "posts", overrideAccess: false });
  expect(anonymousPosts.totalDocs).toBe(1);
  await rejectsWith(
    context.payload.find({ collection: "pages", overrideAccess: false }),
    "Forbidden",
  );
});

test("the union of two roles grants each action either role grants", async () => {
  const union = as(context.payload, users.union);

  const pages = await union.find({ collection: "pages" });
  const post = await union.create({ collection: "posts", data: { title: "By union" } });

  expect(pages.totalDocs).toBe(1);
  expect(post.title).toBe("By union");
  await rejectsWith(union.create({ collection: "pages", data: { title: "no" } }), "Forbidden");
});

test("a role grant cannot override an app false, and an app Where still filters a fully granted role", async () => {
  const notesUser = as(context.payload, users.notesUser);
  const [note] = (await context.payload.find({ collection: "notes" })).docs;

  await rejectsWith(
    notesUser.update({ collection: "notes", data: { title: "edited" }, id: note?.id ?? 0 }),
    "Forbidden",
  );
  const visible = await notesUser.find({ collection: "notes" });
  expect(visible.docs.map((doc) => doc.title)).toEqual(["visible"]);
});

test("a missing app function composes with Payload's default, so read still needs a logged-in user", async () => {
  const anonymous = rest(context, null);
  const reader = rest(context, await login(context.payload, users.reader.email));

  expect((await anonymous("GET", "/pages")).status).toBe(403);
  const response = await reader("GET", "/pages");
  expect(response.status).toBe(200);
  expect(response.json).toMatchObject({ totalDocs: 1 });
});

test("removing a grant takes effect on the user's next request", async () => {
  const { payload } = context;
  const revocable = await seedRole(payload, "revocable", {
    collections: { posts: { actions: ["read"] } },
  });
  const user = await seedUser(payload, { email: "revocable@example.com", roles: [revocable] });
  const { totalDocs } = await payload.count({ collection: "posts" });
  expect((await as(payload, user).find({ collection: "posts" })).totalDocs).toBe(totalDocs);

  await payload.update({ collection: "roles", data: { permissions: {} }, id: revocable });
  await rejectsWith(
    as(payload, await fresh(payload, user.id)).find({ collection: "posts" }),
    "Forbidden",
  );

  await payload.delete({ collection: "roles", id: revocable });
  await rejectsWith(
    as(payload, await fresh(payload, user.id)).find({ collection: "posts" }),
    "Forbidden",
  );
});

test("malformed permissions JSON grants nothing and is reported in the debug log", async () => {
  const { payload } = context;
  const malformed = await payload.create({
    collection: "roles",
    data: { key: "malformed", name: "malformed", permissions: { collections: { posts: "read" } } },
  });
  const user = await seedUser(payload, { email: "malformed@example.com", roles: [malformed.id] });

  await rejectsWith(as(payload, user).find({ collection: "posts" }), "Forbidden");
  expect(context.logs).toContainEqual(
    expect.objectContaining({ event: "permissions_dropped", plugin: "roles", role: malformed.id }),
  );
});

test("me works for a user without read on users, and other users stay hidden", async () => {
  const reader = rest(context, await login(context.payload, users.reader.email));

  const me = await reader("GET", "/users/me");
  const list = await reader("GET", "/users");
  const other = await reader("GET", `/users/${users.nobody.id}`);

  expect(me.status).toBe(200);
  expect(me.json).toMatchObject({ user: { email: users.reader.email } });
  expect(list.json).toMatchObject({ totalDocs: 1, docs: [{ email: users.reader.email }] });
  expect(other.status).toBe(404);
});

test("unlock needs the unlock grant and composes with Payload's admin-collection default", async () => {
  const { payload } = context;
  const unlocker = await seedRole(payload, "unlocker", {
    collections: { users: { actions: ["unlock"] } },
  });
  const user = await seedUser(payload, { email: "unlocker@example.com", roles: [unlocker] });
  const allowed = rest(context, await login(payload, user.email));
  const denied = rest(context, await login(payload, users.reader.email));

  expect((await allowed("POST", "/users/unlock", { email: users.nobody.email })).status).toBe(200);
  expect((await denied("POST", "/users/unlock", { email: users.nobody.email })).status).toBe(403);
});

test("globals compose as booleans: read grant allows, no grant denies, write needs the write grants", async () => {
  const settingsUser = as(context.payload, users.settingsUser);

  await context.payload.updateGlobal({ data: { siteName: "Roles" }, slug: "settings" });

  expect(await settingsUser.findGlobal({ slug: "settings" })).toMatchObject({ siteName: "Roles" });
  await rejectsWith(
    settingsUser.updateGlobal({ data: { siteName: "x" }, slug: "settings" }),
    "Forbidden",
  );
  await rejectsWith(
    as(context.payload, users.nobody).findGlobal({ slug: "settings" }),
    "Forbidden",
  );
});
