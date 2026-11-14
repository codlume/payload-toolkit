// Payload deletes an upload's old file and writes the new one before `beforeChange` (G18), so an
// update the lifecycle refuses must be refused before Payload reaches the stored files.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

type Id = number | string;

const TRASHED = "2026-01-01T00:00:00.000Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const file = (name: string) => ({ data: PNG, mimetype: "image/png", name, size: PNG.length });
const staticDir = mkdtempSync(path.join(tmpdir(), "roles-lifecycle-upload-files-"));
const onDisk = () => readdirSync(staticDir).sort();

let context: TestPayload;
/** Holds update, publish and unpublish, and no trash. */
let editor: Actor;

beforeAll(async () => {
  context = await createTestPayload({
    collections: [
      ...fixtureCollections(),
      {
        fields: [{ name: "alt", type: "text" }],
        slug: "media",
        trash: true,
        upload: { staticDir },
        versions: { drafts: true },
      },
    ],
    name: "lifecycle-upload-files",
    roles: { ...defaultRolesOptions(), collections: ["users", "pages", "posts", "notes", "media"] },
  });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  editor = await seedUser(payload, {
    email: "editor@example.com",
    roles: [
      await seedRole(payload, "editor", {
        collections: { media: { actions: ["read", "update", "publish", "unpublish"] } },
      }),
    ],
  });
});

afterAll(async () => {
  await context.destroy();
  rmSync(staticDir, { force: true, recursive: true });
});

const seedMedia = async (name: string, status: "draft" | "published"): Promise<Id> => {
  const doc = await context.payload.create({
    collection: "media",
    data: { _status: status, alt: name },
    file: file(`${name}.png`),
  });
  return doc.id;
};

const mediaRow = (id: Id) =>
  context.payload.db.findOne<Record<string, unknown> & { id: Id }>({
    collection: "media",
    where: { id: { equals: id } },
  });

/** The main row and the latest version are both in the trash. */
const trashed = async (name: string, status: "draft" | "published") => {
  const id = await seedMedia(name, status);
  await context.payload.update({ collection: "media", data: { deletedAt: TRASHED }, id });
  return id;
};

/** A trashed upload whose latest version the editor's own draft save took out of the trash. */
const trashedBehindUntrashedVersion = async (name: string) => {
  const id = await trashed(name, "published");
  await context.payload.update({
    collection: "media",
    data: { deletedAt: null },
    draft: true,
    id,
    overrideAccess: false,
    trash: true,
    user: editor,
  });
  return id;
};

/** An untrashed upload whose latest version a trusted draft save put in the trash. */
const untrashedBehindTrashedVersion = async (name: string) => {
  const id = await seedMedia(name, "published");
  await context.payload.update({
    collection: "media",
    data: { deletedAt: TRASHED },
    draft: true,
    id,
  });
  return id;
};

type Options = { data?: Record<string, unknown>; draft?: boolean; trash?: boolean };

/** The editor's update with a new file, by id or as a bulk update of that one document. */
const replaceFile = async (
  id: Id,
  bulk: boolean,
  { data, ...flags }: Options,
): Promise<unknown> => {
  const options = {
    collection: "media",
    data: { alt: "replaced", ...data },
    file: file("replacement.png"),
    overrideAccess: false,
    user: editor,
    ...flags,
  };
  return bulk
    ? context.payload.update({ ...options, where: { id: { equals: id } } })
    : context.payload.update({ ...options, id });
};

type Refused = { name: string; seed: () => Promise<Id>; bulk: boolean; options: Options };

const expectUntouched = async ({ seed, bulk, options }: Refused) => {
  const id = await seed();
  const disk = onDisk();
  const row = await mediaRow(id);

  const attempt = replaceFile(id, bulk, options);
  await attempt.catch(() => null);

  expect(onDisk(), "no stored file is deleted or written").toEqual(disk);
  expect(await mediaRow(id), "the stored row is unchanged").toEqual(row);
  await rejectsWith(attempt, "Forbidden");
};

describe("a member without trash cannot replace a file through a write that needs trash", () => {
  test.each<Refused>([
    {
      name: "a live update that finds a trashed upload through its untrashed latest version",
      seed: () => trashedBehindUntrashedVersion("behind-live"),
      bulk: false,
      options: {},
    },
    {
      name: "the same update with trash: true",
      seed: () => trashedBehindUntrashedVersion("behind-flagged"),
      bulk: false,
      options: { trash: true },
    },
    {
      name: "an update with trash: true that finds an untrashed upload through its trashed latest version",
      seed: () => untrashedBehindTrashedVersion("ahead-flagged"),
      bulk: false,
      options: { trash: true },
    },
    {
      name: "a draft save with trash: true over a trashed draft",
      seed: () => trashed("trashed-draft", "draft"),
      bulk: false,
      options: { draft: true, trash: true },
    },
    {
      name: "a bulk publish with draft: true that finds a trashed upload through its untrashed latest version",
      seed: () => trashedBehindUntrashedVersion("behind-bulk"),
      bulk: true,
      options: { data: { _status: "published" }, draft: true },
    },
    {
      name: "a bulk draft save with trash: true over a trashed draft",
      seed: () => trashed("trashed-draft-bulk", "draft"),
      bulk: true,
      options: { draft: true, trash: true },
    },
  ])("$name is refused and the stored file stays", expectUntouched);
});

describe("a member without trash cannot send a new file with a body that sets deletedAt", () => {
  test.each<Refused>([
    {
      name: "an update of an untrashed upload",
      seed: () => seedMedia("to-trash", "published"),
      bulk: false,
      options: { data: { deletedAt: TRASHED } },
    },
    {
      name: "an update that finds a trashed upload through its untrashed latest version",
      seed: () => trashedBehindUntrashedVersion("to-trash-behind"),
      bulk: false,
      options: { data: { deletedAt: TRASHED } },
    },
    {
      name: "an update with trash: true of a trashed upload",
      seed: () => trashed("to-trash-flagged", "published"),
      bulk: false,
      options: { data: { deletedAt: TRASHED }, trash: true },
    },
  ])("$name is refused and the stored file stays", expectUntouched);
});

test("a member without trash still replaces the file of an untrashed upload in bulk", async () => {
  const id = await seedMedia("bulk-replace", "published");

  const result = await replaceFile(id, true, {});

  expect(result).toMatchObject({ docs: [{ id }], errors: [] });
  const row = await mediaRow(id);
  expect(row).toMatchObject({ _status: "published", alt: "replaced" });
  expect(row?.filename).not.toBe("bulk-replace.png");
  expect(onDisk()).toContain(row?.filename);
  expect(onDisk()).not.toContain("bulk-replace.png");
});

test("a new file sent to a missing upload answers not found, as Payload does", async () => {
  const id = await seedMedia("deleted", "published");
  await context.payload.delete({ collection: "media", id });
  const disk = onDisk();

  await rejectsWith(replaceFile(id, false, {}), "NotFound");

  expect(onDisk()).toEqual(disk);
});
