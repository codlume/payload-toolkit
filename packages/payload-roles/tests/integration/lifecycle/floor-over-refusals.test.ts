import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

const STATUS = "_status";
const TRASHED = "2026-01-01T00:00:00.000Z";

let context: TestPayload;
let users: Record<"restorer" | "trashOnly", Actor>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-floor-over-refusals" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, actions: string[]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [await seedRole(payload, key, { collections: { pages: { actions } } })],
    });
  users = {
    restorer: await member("restorer-no-publish", ["read", "update", "trash", "readVersions"]),
    trashOnly: await member("trash-only", ["read", "trash"]),
  };
});

afterAll(() => context.destroy());

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

const mainRow = async (id: number | string) => {
  const row = await context.payload.db.findOne<Record<string, unknown> & { id: number | string }>({
    collection: "pages",
    where: { id: { equals: id } },
  });
  return { [STATUS]: row?.[STATUS], deletedAt: row?.deletedAt ?? null };
};

const pageWithTrashedSnapshot = async () => {
  const { payload } = context;
  const { id } = await payload.create({
    collection: "pages",
    data: { [STATUS]: "published", title: "snapshot" },
  });
  await tick();
  await payload.update({ collection: "pages", data: { deletedAt: TRASHED }, id });
  await tick();
  const { docs } = await payload.db.findVersions({
    collection: "pages",
    limit: 1,
    pagination: false,
    sort: "-updatedAt",
    where: { parent: { equals: id } },
  });
  await payload.update({
    collection: "pages",
    data: { [STATUS]: "draft", deletedAt: null },
    id,
    trash: true,
  });
  await tick();
  return { id, version: docs[0]?.id ?? "missing" };
};

describe("restoring a trashed published snapshot leaves the page in the trash, not live", () => {
  test("a trusted restore stores it trashed", async () => {
    const { id, version } = await pageWithTrashedSnapshot();
    await context.payload.restoreVersion({ collection: "pages", id: version });
    expect(await mainRow(id)).toEqual({ [STATUS]: "published", deletedAt: TRASHED });
  });

  test("needs update, readVersions and trash, not publish", async () => {
    const { id, version } = await pageWithTrashedSnapshot();
    await context.payload.restoreVersion({
      collection: "pages",
      id: version,
      overrideAccess: false,
      user: users.restorer,
    });
    expect(await mainRow(id)).toEqual({ [STATUS]: "published", deletedAt: TRASHED });
  });
});

const trashedBehindUntrashedVersion = async () => {
  const { payload } = context;
  const { id } = await payload.create({
    collection: "pages",
    data: { [STATUS]: "draft", deletedAt: TRASHED, title: "behind" },
  });
  await tick();
  await payload.update({
    collection: "pages",
    data: { deletedAt: null },
    draft: true,
    id,
    trash: true,
  });
  await tick();
  return id;
};

describe("a live write that takes a trashed page out of the trash through its latest version", () => {
  test("a trusted write stores it out of the trash", async () => {
    const id = await trashedBehindUntrashedVersion();
    await context.payload.update({ collection: "pages", data: { [STATUS]: "draft" }, id });
    expect(await mainRow(id)).toEqual({ [STATUS]: "draft", deletedAt: null });
  });

  test("needs only trash, as restore from trash as draft does (T2)", async () => {
    const id = await trashedBehindUntrashedVersion();
    await context.payload.update({
      collection: "pages",
      data: { [STATUS]: "draft" },
      id,
      overrideAccess: false,
      user: users.trashOnly,
    });
    expect(await mainRow(id)).toEqual({ [STATUS]: "draft", deletedAt: null });
  });
});

const untrashedBehindTrashedVersion = async () => {
  const { payload } = context;
  const { id } = await payload.create({
    collection: "pages",
    data: { [STATUS]: "draft", title: "ahead" },
  });
  await tick();
  await payload.update({ collection: "pages", data: { deletedAt: TRASHED }, draft: true, id });
  await tick();
  return id;
};

describe("a status write that moves a page into the trash through its latest version", () => {
  test("a trusted write stores it trashed", async () => {
    const id = await untrashedBehindTrashedVersion();
    await context.payload.update({
      collection: "pages",
      data: { [STATUS]: "published" },
      id,
      trash: true,
    });
    expect(await mainRow(id)).toEqual({ [STATUS]: "published", deletedAt: TRASHED });
  });

  test("needs only trash, as moving to the trash does (T1)", async () => {
    const id = await untrashedBehindTrashedVersion();
    await context.payload.update({
      collection: "pages",
      data: { [STATUS]: "published" },
      id,
      overrideAccess: false,
      trash: true,
      user: users.trashOnly,
    });
    expect(await mainRow(id)).toEqual({ [STATUS]: "published", deletedAt: TRASHED });
  });
});
