import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

type Role = "trashOnly" | "trashPublish" | "updateOnly";

const STATUS = "_status";
const TRASHED = "2026-01-01T00:00:00.000Z";

let context: TestPayload;
let actors: Record<Role, Actor>;
let tokens: Record<Role, string>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-deleted-at-null" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, actions: string[]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [await seedRole(payload, key, { collections: { pages: { actions } } })],
    });
  actors = {
    trashOnly: await member("trash-only", ["read", "trash"]),
    trashPublish: await member("trash-publish", ["read", "update", "publish", "trash"]),
    updateOnly: await member("update-only", ["read", "update"]),
  };
  tokens = {
    trashOnly: await login(payload, actors.trashOnly.email),
    trashPublish: await login(payload, actors.trashPublish.email),
    updateOnly: await login(payload, actors.updateOnly.email),
  };
});

afterAll(() => context.destroy());

const page = async (status: "draft" | "published", title: string, trashed = false) => {
  const created = await context.payload.create({
    collection: "pages",
    data: { _status: status, title, ...(trashed && { deletedAt: TRASHED }) },
  });
  return created.id;
};

const stored = async (id: number | string) => {
  const row = await context.payload.db.findOne<Record<string, unknown> & { id: number | string }>({
    collection: "pages",
    where: { id: { equals: id } },
  });
  return { [STATUS]: row?.[STATUS], deletedAt: row?.deletedAt ?? null, title: row?.title };
};

const api = (role: Role) => rest(context, tokens[role]);

describe("deletedAt: null with no trash transition never needs trash", () => {
  test("a non-draft edit of a draft page carrying deletedAt: null needs only update (REST and Local)", async () => {
    const restId = await page("draft", "rest edit");
    const response = await api("updateOnly")("PATCH", `/pages/${restId}`, {
      deletedAt: null,
      title: "rest edited",
    });
    expect(response.status).toBe(200);
    expect(await stored(restId)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "rest edited",
    });

    const localId = await page("draft", "local edit");
    await as(context.payload, actors.updateOnly).update({
      collection: "pages",
      data: { deletedAt: null, title: "local edited" },
      id: localId,
    });
    expect(await stored(localId)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "local edited",
    });
  });

  test("a draft save of a published page carrying deletedAt: null needs only update and leaves the live row", async () => {
    const id = await page("published", "live");
    const response = await api("updateOnly")("PATCH", `/pages/${id}?draft=true`, {
      _status: "draft",
      deletedAt: null,
      title: "pending",
    });
    expect(response.status).toBe(200);
    expect(await stored(id)).toEqual({ _status: "published", deletedAt: null, title: "live" });
  });

  test("a body of only deletedAt: null on an untrashed page is a plain write that needs update, not trash", async () => {
    const allowed = await page("draft", "only null");
    expect(
      (await api("updateOnly")("PATCH", `/pages/${allowed}`, { deletedAt: null })).status,
    ).toBe(200);
    expect(await stored(allowed)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "only null",
    });

    const denied = await page("draft", "only null denied");
    expect((await api("trashOnly")("PATCH", `/pages/${denied}`, { deletedAt: null })).status).toBe(
      403,
    );
    expect(await stored(denied)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "only null denied",
    });
  });

  test("trash alone cannot make a content edit by sending deletedAt: null", async () => {
    const id = await page("draft", "trash cannot edit");
    await rejectsWith(
      as(context.payload, actors.trashOnly).update({
        collection: "pages",
        data: { deletedAt: null, title: "edited by trash" },
        id,
      }),
      "Forbidden",
    );
    expect(await stored(id)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "trash cannot edit",
    });
  });

  test("the admin document probe with deletedAt: null grants save to update-only and not to trash-only", async () => {
    const id = await page("published", "probe");
    const body = { _status: "draft", deletedAt: null, title: "probe" };
    const updateOnly = await api("updateOnly")("POST", `/pages/access/${id}`, body);
    const trashOnly = await api("trashOnly")("POST", `/pages/access/${id}`, body);

    expect(updateOnly.status).toBe(200);
    expect(updateOnly.json).toMatchObject({ update: true });
    expect(trashOnly.json, "Payload omits a denied permission").not.toHaveProperty("update");
  });
});

describe("real trash transitions still need trash", () => {
  test("moving to trash is allowed for trash-only and refused for update-only", async () => {
    const allowed = await page("published", "to trash");
    expect(
      (await api("trashOnly")("PATCH", `/pages/${allowed}`, { deletedAt: TRASHED })).status,
    ).toBe(200);
    expect((await stored(allowed)).deletedAt).toBe(TRASHED);

    const denied = await page("published", "not to trash");
    expect(
      (await api("updateOnly")("PATCH", `/pages/${denied}`, { deletedAt: TRASHED })).status,
    ).toBe(403);
    expect(await stored(denied)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "not to trash",
    });
  });

  test("restoring from trash with deletedAt: null is allowed for trash-only and refused per document for update-only", async () => {
    const allowed = await page("published", "restore draft", true);
    const restored = await api("trashOnly")(
      "PATCH",
      `/pages?trash=true&where[id][equals]=${allowed}`,
      { _status: "draft", deletedAt: null },
    );
    expect(restored.status).toBe(200);
    expect(await stored(allowed)).toEqual({
      _status: "draft",
      deletedAt: null,
      title: "restore draft",
    });

    const denied = await page("published", "stays trashed", true);
    const refused = await api("updateOnly")(
      "PATCH",
      `/pages?trash=true&where[id][equals]=${denied}`,
      { _status: "draft", deletedAt: null },
    );
    expect(refused.status).toBe(400);
    expect(await stored(denied)).toEqual({
      _status: "published",
      deletedAt: TRASHED,
      title: "stays trashed",
    });
  });

  test("restoring from trash as published needs publish on top of trash", async () => {
    const denied = await page("draft", "restore live denied", true);
    const refused = await api("trashOnly")(
      "PATCH",
      `/pages?trash=true&where[id][equals]=${denied}`,
      { _status: "published", deletedAt: null },
    );
    expect(refused.status).toBe(403);
    expect(await stored(denied)).toEqual({
      _status: "draft",
      deletedAt: TRASHED,
      title: "restore live denied",
    });

    const allowed = await page("draft", "restore live", true);
    const restored = await api("trashPublish")(
      "PATCH",
      `/pages?trash=true&where[id][equals]=${allowed}`,
      { _status: "published", deletedAt: null },
    );
    expect(restored.status).toBe(200);
    expect(await stored(allowed)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "restore live",
    });
  });
});
