// Seeded by core. The lifecycle thread may replace this file once its hooks classify writes.
// Until then, every write on a drafts, trash or versioned resource needs every action it could
// possibly need, so publish, unpublish, trash and readVersions never allow a write on their own.
import { afterAll, beforeAll, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let users: Record<
  | "publishOnly"
  | "readVersionsOnly"
  | "settingsFull"
  | "settingsUpdate"
  | "trashOnly"
  | "unpublishOnly"
  | "updateOnly"
  | "writer"
  | "writerFull",
  Actor
>;

const PAGES_WRITE = ["read", "create", "update", "publish", "unpublish"];

beforeAll(async () => {
  context = await createTestPayload({ name: "interim" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const role = async (key: string, actions: string[], target: "pages" | "settings" = "pages") =>
    seedRole(
      payload,
      key,
      target === "pages"
        ? { collections: { pages: { actions } } }
        : { globals: { settings: { actions } } },
    );
  const user = async (email: string, roleId: number | string) =>
    seedUser(payload, { email: `${email}@example.com`, roles: [roleId] });
  users = {
    publishOnly: await user("publish-only", await role("publish-only", ["read", "publish"])),
    readVersionsOnly: await user(
      "read-versions-only",
      await role("read-versions-only", ["read", "readVersions"]),
    ),
    settingsFull: await user(
      "settings-full",
      await role(
        "settings-full",
        ["read", "update", "publish", "unpublish", "readVersions"],
        "settings",
      ),
    ),
    settingsUpdate: await user(
      "settings-update",
      await role("settings-update", ["read", "update"], "settings"),
    ),
    trashOnly: await user("trash-only", await role("trash-only", ["read", "trash"])),
    unpublishOnly: await user(
      "unpublish-only",
      await role("unpublish-only", ["read", "unpublish"]),
    ),
    updateOnly: await user("update-only", await role("update-only", ["read", "update"])),
    writer: await user("writer", await role("writer", PAGES_WRITE)),
    writerFull: await user(
      "writer-full",
      await role("writer-full", [...PAGES_WRITE, "trash", "readVersions", "delete"]),
    ),
  };
});

afterAll(() => context.destroy());

const publishedPage = async (title: string) => {
  const page = await context.payload.create({
    collection: "pages",
    data: { _status: "published", title },
  });
  return page.id;
};

test("publish, unpublish, trash and readVersions never allow a write on their own", async () => {
  const id = await publishedPage("Lifecycle-only grants");
  const { payload } = context;

  await rejectsWith(
    as(payload, users.publishOnly).update({
      collection: "pages",
      data: { _status: "published" },
      id,
    }),
    "Forbidden",
  );
  await rejectsWith(
    as(payload, users.unpublishOnly).update({
      collection: "pages",
      data: { _status: "draft" },
      id,
    }),
    "Forbidden",
  );
  await rejectsWith(
    as(payload, users.trashOnly).update({
      collection: "pages",
      data: { deletedAt: new Date().toISOString() },
      id,
    }),
    "Forbidden",
  );
  await rejectsWith(
    as(payload, users.readVersionsOnly).update({
      collection: "pages",
      data: { _status: "draft" },
      id,
    }),
    "Forbidden",
  );
  await rejectsWith(
    as(payload, users.publishOnly).create({
      collection: "pages",
      data: { _status: "published", title: "x" },
    }),
    "Forbidden",
  );

  const stored = await payload.findByID({ collection: "pages", depth: 0, id });
  expect(stored).toMatchObject({ _status: "published", title: "Lifecycle-only grants" });
});

test("update alone cannot write a drafts collection; it needs publish and unpublish too", async () => {
  const id = await publishedPage("Update only");
  const updateOnly = rest(context, await login(context.payload, users.updateOnly.email));

  expect((await updateOnly("PATCH", `/pages/${id}`, { title: "edited" })).status).toBe(403);
  expect(
    (await updateOnly("PATCH", `/pages/${id}?draft=true`, { _status: "draft", title: "draft" }))
      .status,
  ).toBe(403);
  expect((await updateOnly("POST", "/pages", { _status: "draft", title: "new" })).status).toBe(403);

  const writer = rest(context, await login(context.payload, users.writer.email));
  expect((await writer("PATCH", `/pages/${id}`, { title: "edited by writer" })).status).toBe(200);
  expect(
    (await writer("POST", "/pages", { _status: "draft", title: "draft by writer" })).status,
  ).toBe(201);
  expect((await writer("POST", "/pages", { title: "published by writer" })).status).toBe(201);
});

test("trash and status-only bodies need the trash and readVersions grants on top of the write grants", async () => {
  const id = await publishedPage("Trash and status");
  const writer = as(context.payload, users.writer);
  const writerFull = as(context.payload, users.writerFull);

  await rejectsWith(
    writer.update({ collection: "pages", data: { deletedAt: new Date().toISOString() }, id }),
    "Forbidden",
  );
  await rejectsWith(
    writer.update({ collection: "pages", data: { _status: "draft" }, id }),
    "Forbidden",
  );

  expect(
    await writerFull.update({ collection: "pages", data: { _status: "draft" }, id }),
  ).toMatchObject({ _status: "draft" });
  const trashed = await writerFull.update({
    collection: "pages",
    data: { deletedAt: new Date().toISOString() },
    id,
  });
  expect(trashed.deletedAt).toBeTypeOf("string");
});

test("reading versions needs readVersions; restoring needs the write grants plus readVersions", async () => {
  const id = await publishedPage("Versions");
  await context.payload.update({ collection: "pages", data: { title: "Versions v2" }, id });
  const { payload } = context;
  const versions = await payload.findVersions({
    collection: "pages",
    where: { parent: { equals: id } },
  });
  const versionId = versions.docs[0]?.id ?? "";

  await rejectsWith(
    as(payload, users.updateOnly).findVersions({
      collection: "pages",
      where: { parent: { equals: id } },
    }),
    "Forbidden",
  );
  expect(
    (
      await as(payload, users.readVersionsOnly).findVersions({
        collection: "pages",
        where: { parent: { equals: id } },
      })
    ).totalDocs,
  ).toBeGreaterThan(0);

  await rejectsWith(
    as(payload, users.writer).restoreVersion({ collection: "pages", id: versionId }),
    "Forbidden",
  );
  await rejectsWith(
    as(payload, users.readVersionsOnly).restoreVersion({ collection: "pages", id: versionId }),
    "Forbidden",
  );
  expect(
    await as(payload, users.writerFull).restoreVersion({ collection: "pages", id: versionId }),
  ).toMatchObject({ id });
});

test("a drafts global needs update, publish and unpublish for any write", async () => {
  const settingsUpdate = rest(context, await login(context.payload, users.settingsUpdate.email));
  const settingsFull = rest(context, await login(context.payload, users.settingsFull.email));

  expect((await settingsUpdate("POST", "/globals/settings", { siteName: "nope" })).status).toBe(
    403,
  );
  expect((await settingsFull("POST", "/globals/settings", { siteName: "yes" })).status).toBe(200);
  expect(await context.payload.findGlobal({ slug: "settings" })).toMatchObject({ siteName: "yes" });
});

test("trusted Local API writes bypass the roles side entirely", async () => {
  const id = await publishedPage("Trusted");
  const updated = await context.payload.update({
    collection: "pages",
    data: { _status: "draft" },
    id,
  });
  expect(updated).toMatchObject({ _status: "draft" });
});
