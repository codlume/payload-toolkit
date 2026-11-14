import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

const STATUS = "_status";
const TRASHED = "2026-01-01T00:00:00.000Z";

let context: TestPayload;
let users: Record<"publisher" | "unpublisher", Actor>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-trashed-main-row" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, actions: string[]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [await seedRole(payload, key, { collections: { pages: { actions } } })],
    });
  users = {
    publisher: await member("publisher-no-trash", ["read", "update", "publish"]),
    unpublisher: await member("unpublisher-no-trash", ["read", "update", "unpublish"]),
  };
});

afterAll(() => context.destroy());

const trashedPage = async (status: "draft" | "published", title: string) =>
  (
    await context.payload.create({
      collection: "pages",
      data: { [STATUS]: status, deletedAt: TRASHED, title },
    })
  ).id;

const mainRow = async (id: number | string) => {
  const row = await context.payload.db.findOne<Record<string, unknown> & { id: number | string }>({
    collection: "pages",
    where: { id: { equals: id } },
  });
  return { [STATUS]: row?.[STATUS], deletedAt: row?.deletedAt ?? null, title: row?.title };
};

/** A draft save is allowed with update alone, and clears `deletedAt` on the latest version only. */
const clearOnLatestVersion = async (token: string, id: number | string) => {
  const response = await rest(context, token)("PATCH", `/pages/${id}?trash=true&draft=true`, {
    deletedAt: null,
  });
  expect(response.status, "the draft save needs only update").toBe(200);
};

describe("a member without trash cannot restore a trashed page through its latest version", () => {
  test("publishing it over REST is refused and the page stays in the trash", async () => {
    const id = await trashedPage("published", "trashed live");
    const token = await login(context.payload, users.publisher.email);
    await clearOnLatestVersion(token, id);

    const response = await rest(context, token)("PATCH", `/pages/${id}`, {
      [STATUS]: "published",
      deletedAt: null,
    });

    expect(response.status, "restoring from trash needs trash").toBe(403);
    expect(await mainRow(id)).toMatchObject({ [STATUS]: "published", deletedAt: TRASHED });
  });

  test("unpublishing it over REST is refused and the page stays in the trash", async () => {
    const id = await trashedPage("published", "trashed unpublish");
    const token = await login(context.payload, users.unpublisher.email);
    await clearOnLatestVersion(token, id);

    const response = await rest(context, token)("PATCH", `/pages/${id}`, {
      [STATUS]: "draft",
      deletedAt: null,
    });

    expect(response.status, "restoring from trash needs trash").toBe(403);
    expect((await mainRow(id)).deletedAt).toBe(TRASHED);
  });

  test("a Local API live edit without a deletedAt key is refused and the page stays in the trash", async () => {
    const id = await trashedPage("published", "trashed local");
    await clearOnLatestVersion(await login(context.payload, users.publisher.email), id);

    await rejectsWith(
      context.payload.update({
        collection: "pages",
        data: { [STATUS]: "published", title: "live now" },
        id,
        overrideAccess: false,
        user: users.publisher,
      }),
      "Forbidden",
    );

    expect(await mainRow(id)).toMatchObject({ deletedAt: TRASHED, title: "trashed local" });
  });
});
