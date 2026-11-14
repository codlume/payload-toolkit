// The users write guard reads a role only when its decision compares that role's grants, and a
// bulk write reads each role once. The refusals that depend on those grants still hold.
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";

import { type Actor, PASSWORD, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

type Id = number | string;

let context: TestPayload;
let roles: Record<"pagesReader" | "pagesWriter" | "usersEditor", Id>;
let superAdmin: Actor;
/** Holds `usersEditor` alone, so a read of another role is the guard's and never the resolver's. */
let editor: Actor;
let writer: Actor;
let readers: Actor[];
/** The role ids each database read of the roles collection asked for. */
const rolesReads: string[][] = [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const idsAsked = (where: unknown): string[] => {
  const id: unknown = isRecord(where) ? where.id : undefined;
  const asked: unknown = isRecord(id) ? id.in : undefined;
  return Array.isArray(asked) ? asked.map(String) : [];
};

const readsOf = (role: Id) => rolesReads.filter((ids) => ids.includes(String(role))).length;

// Depth 0, so Payload itself reads no role to populate the result.
const update = (user: Actor, id: Id, data: Record<string, unknown>) =>
  context.payload.update({
    collection: "users",
    data,
    depth: 0,
    id,
    overrideAccess: false,
    user,
  });

const updateMany = (user: Actor, targets: Actor[], data: Record<string, unknown>) =>
  context.payload.update({
    collection: "users",
    data,
    depth: 0,
    overrideAccess: false,
    user,
    where: { id: { in: targets.map((target) => target.id) } },
  });

const storedRoles = async (user: Actor) => {
  const doc = await context.payload.findByID({ collection: "users", depth: 0, id: user.id });
  return doc.roles;
};

beforeAll(async () => {
  const collections = fixtureCollections();
  collections
    .find((collection) => collection.slug === "users")
    ?.fields.push({ name: "name", type: "text" });
  context = await createTestPayload({ collections, name: "guard-reads" });
  const { payload } = context;
  superAdmin = await seedUser(payload, { email: "super@example.com" });
  roles = {
    pagesReader: await seedRole(payload, "pages-reader", {
      collections: { pages: { actions: ["read"] } },
    }),
    pagesWriter: await seedRole(payload, "pages-writer", {
      collections: { pages: { actions: ["read", "update"] } },
    }),
    usersEditor: await seedRole(payload, "users-editor", {
      collections: { pages: { actions: ["read"] }, users: { actions: ["read", "update"] } },
    }),
  };
  editor = await seedUser(payload, { email: "editor@example.com", roles: [roles.usersEditor] });
  writer = await seedUser(payload, { email: "writer@example.com", roles: [roles.pagesWriter] });
  readers = [];
  for (const name of ["a", "b", "c", "d"]) {
    readers.push(
      // oxlint-disable-next-line no-await-in-loop -- users are created one at a time
      await seedUser(payload, { email: `reader-${name}@example.com`, roles: [roles.pagesReader] }),
    );
  }
  const { db } = payload;
  const find = db.find.bind(db);
  vi.spyOn(db, "find").mockImplementation((args) => {
    if (args.collection === "roles") {
      rolesReads.push(idsAsked(args.where));
    }
    return find(args);
  });
});

beforeEach(() => {
  rolesReads.length = 0;
});

afterAll(() => context.destroy());

test("an update that changes no role and no credential reads no role", async () => {
  const [reader] = readers;
  if (!reader) {
    throw new Error("no reader was seeded");
  }

  expect(await update(superAdmin, reader.id, { name: "By the super admin" })).toMatchObject({
    name: "By the super admin",
  });
  expect(rolesReads).toEqual([]);

  expect(await update(editor, reader.id, { name: "By the editor" })).toMatchObject({
    name: "By the editor",
  });
  expect(
    await update(editor, reader.id, { email: reader.email, name: "Same email" }),
  ).toMatchObject({ name: "Same email" });
  expect(readsOf(roles.pagesReader)).toBe(0);

  const bulk = await updateMany(editor, readers, { name: "In bulk" });
  expect(bulk.errors).toEqual([]);
  expect(bulk.docs.map((doc) => doc.name)).toEqual(readers.map(() => "In bulk"));
  expect(readsOf(roles.pagesReader)).toBe(0);
});

test("a bulk role change reads each role once, however many users it writes", async () => {
  const assigned = await updateMany(superAdmin, readers, { roles: [roles.pagesWriter] });
  const reads = [...rolesReads];
  await context.payload.update({
    collection: "users",
    data: { roles: [roles.pagesReader] },
    where: { id: { in: readers.map((reader) => reader.id) } },
  });

  expect(assigned.errors).toEqual([]);
  expect(assigned.docs).toHaveLength(readers.length);
  expect(reads.map((ids) => ids.toSorted())).toEqual([
    [String(roles.pagesReader), String(roles.pagesWriter)].toSorted(),
  ]);
});

test("a credential change still compares the target's roles with the editor's", async () => {
  const [reader] = readers;
  if (!reader) {
    throw new Error("no reader was seeded");
  }

  await rejectsWith(update(editor, writer.id, { password: "taken over" }), "Forbidden");
  expect(readsOf(roles.pagesWriter)).toBe(1);
  await expect(
    context.payload.login({
      collection: "users",
      data: { email: writer.email, password: PASSWORD },
    }),
  ).resolves.toMatchObject({ user: { id: writer.id } });

  await rejectsWith(update(editor, superAdmin.id, { email: "taken@example.com" }), "Forbidden");

  await update(editor, reader.id, { password: PASSWORD });
  expect(readsOf(roles.pagesReader)).toBe(1);
});

test("a role change still needs the editor to cover every role added or removed", async () => {
  const [reader] = readers;
  if (!reader) {
    throw new Error("no reader was seeded");
  }

  await rejectsWith(update(editor, reader.id, { roles: [roles.pagesWriter] }), "Forbidden");
  await rejectsWith(update(editor, reader.id, { roles: [987_654] }), "Forbidden");
  await rejectsWith(update(editor, writer.id, { roles: [] }), "Forbidden");
  await rejectsWith(update(editor, editor.id, { roles: [roles.pagesReader] }), "Forbidden");
  await rejectsWith(update(editor, reader.id, { superAdmin: true }), "Forbidden");
  expect(await storedRoles(reader)).toEqual([roles.pagesReader]);
  expect(await storedRoles(writer)).toEqual([roles.pagesWriter]);
  expect(await storedRoles(editor)).toEqual([roles.usersEditor]);
});

test("a bulk write that shares its role reads is still judged one user at a time", async () => {
  const [first, second] = readers;
  if (!first || !second) {
    throw new Error("no readers were seeded");
  }

  const passwords = await updateMany(editor, [first, writer, second], { password: PASSWORD });
  expect(passwords.docs).toHaveLength(2);
  expect(passwords.docs.map((doc) => doc.id)).toEqual(
    expect.arrayContaining([first.id, second.id]),
  );
  expect(passwords.errors).toMatchObject([{ id: writer.id }]);
  expect(readsOf(roles.pagesReader)).toBe(1);
  expect(readsOf(roles.pagesWriter)).toBe(1);

  const escalated = await updateMany(editor, readers, { roles: [roles.pagesWriter] });
  expect(escalated.docs).toEqual([]);
  expect(escalated.errors).toHaveLength(readers.length);

  const stripped = await updateMany(editor, [first, writer], { roles: [] });
  expect(stripped.docs.map((doc) => doc.id)).toEqual([first.id]);
  expect(stripped.errors).toMatchObject([{ id: writer.id }]);
  expect(await storedRoles(writer)).toEqual([roles.pagesWriter]);
  expect(await storedRoles(second)).toEqual([roles.pagesReader]);
});
