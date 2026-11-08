import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, as, graphql, login, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

const mainRow = (payload: Payload, collection: string, id: number | string) =>
  payload.db.findOne({ collection, where: { id: { equals: id } } });

const newestVersionId = async (payload: Payload, collection: string, parent: number | string) => {
  const { docs } = await payload.db.findVersions({
    collection,
    limit: 1,
    pagination: false,
    sort: "-id",
    where: { parent: { equals: parent } },
  });
  const id = docs[0]?.id;
  if (id === undefined) {
    throw new Error(`no version of ${collection} ${String(parent)}`);
  }
  return id;
};

describe("a restore earlier in one GraphQL document", () => {
  let context: TestPayload;
  let token: string;

  beforeAll(async () => {
    context = await createTestPayload({ name: "lifecycle-regression-graphql-restore" });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    const role = await seedRole(payload, "restore-then-edit", {
      collections: { pages: { actions: ["read", "update", "unpublish", "readVersions"] } },
      globals: { settings: { actions: ["read", "update", "readVersions"] } },
    });
    const member = await seedUser(payload, { email: "restorer@example.com", roles: [role] });
    token = await login(payload, member.email);
    await payload.updateGlobal({ data: { siteName: "first" }, slug: "settings" });
    await payload.updateGlobal({ data: { siteName: "second" }, slug: "settings" });
  });

  afterAll(() => context.destroy());

  const livePage = async (title: string) =>
    (await context.payload.create({ collection: "pages", data: { _status: "published", title } }))
      .id;

  test("does not let a later update change a live page without publish after a global restore", async () => {
    const { payload } = context;
    const id = await livePage("live after global restore");
    const { docs } = await payload.db.findGlobalVersions({
      global: "settings",
      limit: 1,
      pagination: false,
      sort: "id",
    });
    const versionId = docs[0]?.id;

    const result = await graphql(
      context,
      token,
      `
        mutation ($version: Int!, $id: Int!) {
          a: restoreVersionSetting(id: $version, draft: true) {
            siteName
          }
          b: updatePage(id: $id, data: { title: "defaced" }) {
            id
          }
        }
      `,
      { id, version: versionId },
    );

    expect(result.data?.b, "the live edit needs publish").toBeNull();
    expect(await mainRow(payload, "pages", id)).toMatchObject({
      _status: "published",
      title: "live after global restore",
    });
  });

  test("does not let a later update change a live page without publish after a page restore", async () => {
    const { payload } = context;
    const id = await livePage("live after page restore");
    const other = await livePage("other page");
    await payload.update({ collection: "pages", data: { title: "other v2" }, id: other });
    const versionId = await newestVersionId(payload, "pages", other);

    const result = await graphql(
      context,
      token,
      `
        mutation ($version: Int!, $id: Int!) {
          a: restoreVersionPage(id: $version, draft: true) {
            id
          }
          b: updatePage(id: $id, data: { title: "defaced" }) {
            id
          }
        }
      `,
      { id, version: versionId },
    );

    expect(result.data?.a, "a draft restore needs only readVersions and update").not.toBeNull();
    expect(result.data?.b, "the live edit needs publish").toBeNull();
    expect(await mainRow(payload, "pages", id)).toMatchObject({
      _status: "published",
      title: "live after page restore",
    });
  });
});

describe("restoring one's own user version", () => {
  let context: TestPayload;
  let member: Actor;
  let other: Actor;

  beforeAll(async () => {
    context = await createTestPayload({
      collections: fixtureCollections().map((collection) =>
        collection.slug === "users" ? Object.assign(collection, { versions: true }) : collection,
      ),
      name: "lifecycle-regression-self-restore",
    });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    const role = await seedRole(payload, "self-versions", {
      collections: { users: { actions: ["read", "readVersions"] } },
    });
    member = await seedUser(payload, { email: "self@example.com", roles: [role] });
    other = await seedUser(payload, { email: "other@example.com", roles: [role] });
  });

  afterAll(() => context.destroy());

  test("is allowed without update, like core's self-update, while another user's restore is not", async () => {
    const { payload } = context;
    const own = await newestVersionId(payload, "users", member.id);
    const theirs = await newestVersionId(payload, "users", other.id);

    await expect(
      as(payload, member).restoreVersion({ collection: "users", id: own }),
    ).resolves.toMatchObject({ id: member.id });
    await rejectsWith(
      as(payload, member).restoreVersion({ collection: "users", id: theirs }),
      "Forbidden",
    );
  });
});

describe("an upload draft save that carries a new file", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const file = (name: string) => ({ data: PNG, mimetype: "image/png", name, size: PNG.length });
  const staticDir = mkdtempSync(path.join(tmpdir(), "roles-lifecycle-regression-media-"));
  const onDisk = () => readdirSync(staticDir).sort();
  let context: TestPayload;
  let users: Record<"publisher" | "updateOnly", Actor>;

  beforeAll(async () => {
    context = await createTestPayload({
      collections: [
        ...fixtureCollections(),
        {
          fields: [{ name: "alt", type: "text" }],
          slug: "media",
          upload: { staticDir },
          versions: { drafts: true },
        },
      ],
      name: "lifecycle-regression-upload-draft",
      roles: { ...defaultRolesOptions(), collections: ["users", "pages", "media"] },
    });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    const member = async (key: string, actions: string[]) =>
      seedUser(payload, {
        email: `${key}@example.com`,
        roles: [await seedRole(payload, key, { collections: { media: { actions } } })],
      });
    users = {
      publisher: await member("publisher", ["read", "update", "publish"]),
      updateOnly: await member("update-only", ["read", "update"]),
    };
  });

  afterAll(async () => {
    await context.destroy();
    rmSync(staticDir, { force: true, recursive: true });
  });

  const liveWithPendingDraft = async (name: string) => {
    const { payload } = context;
    const created = await payload.create({
      collection: "media",
      data: { _status: "published", alt: "live" },
      file: file(name),
    });
    await payload.update({
      collection: "media",
      data: { alt: "pending" },
      draft: true,
      id: created.id,
    });
    return created.id;
  };

  test("needs publish, because Payload can delete the live file, and the disk is unchanged on denial", async () => {
    const { payload } = context;
    const id = await liveWithPendingDraft("live-denied.png");
    const before = onDisk();

    await rejectsWith(
      payload.update({
        collection: "media",
        data: { alt: "new file" },
        draft: true,
        file: file("next-denied.png"),
        id,
        overrideAccess: false,
        user: users.updateOnly,
      }),
      "Forbidden",
    );

    expect(onDisk()).toEqual(before);
    expect(await mainRow(payload, "media", id)).toMatchObject({
      _status: "published",
      filename: "live-denied.png",
    });
  });

  test("is allowed for a publisher", async () => {
    const id = await liveWithPendingDraft("live-allowed.png");

    await expect(
      context.payload.update({
        collection: "media",
        data: { alt: "new file" },
        draft: true,
        file: file("next-allowed.png"),
        id,
        overrideAccess: false,
        user: users.publisher,
      }),
    ).resolves.toMatchObject({ id });
  });

  test("with the focal point the admin form always sends stays an update-only draft save", async () => {
    const { payload } = context;
    const id = await liveWithPendingDraft("live-focal.png");
    const before = onDisk();

    const save = (autosave: boolean) =>
      payload.update({
        autosave,
        collection: "media",
        data: { alt: "focal draft", focalX: 10, focalY: 90 },
        draft: true,
        id,
        overrideAccess: false,
        user: users.updateOnly,
      });
    await expect(save(false), "a draft save").resolves.toMatchObject({ id });
    await expect(save(true), "an autosave").resolves.toMatchObject({ id });

    expect(onDisk()).toEqual(before);
    expect(await mainRow(payload, "media", id)).toMatchObject({
      _status: "published",
      filename: "live-focal.png",
    });
  });

  test("without a file stays an update-only draft save", async () => {
    const { payload } = context;
    const id = await liveWithPendingDraft("live-plain.png");

    await expect(
      payload.update({
        collection: "media",
        data: { alt: "draft alt" },
        draft: true,
        id,
        overrideAccess: false,
        user: users.updateOnly,
      }),
    ).resolves.toMatchObject({ id });
    expect(await mainRow(payload, "media", id)).toMatchObject({
      _status: "published",
      alt: "live",
    });
  });
});
