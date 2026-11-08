// Lifecycle enforcement on the surfaces beside plain REST and Local writes: upload files, scheduled
// publish jobs, GraphQL mutations and the admin's copy-to-locale action.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { copyDataFromLocale } from "@payloadcms/ui/utilities/copyDataFromLocale";
import { type CollectionConfig, createLocalReq, handleEndpoints, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, as, graphql, login, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

const pagesRole = (payload: Payload, key: string, actions: string[]) =>
  seedRole(payload, key, { collections: { pages: { actions } } });

const memberWith = async (payload: Payload, key: string, roleId: number | string) =>
  seedUser(payload, { email: `${key}@example.com`, roles: [roleId] });

const storedRow = async (payload: Payload, collection: string, id: number | string) =>
  payload.db.findOne({ collection, where: { id: { equals: id } } });

const withPages = (patch: Partial<CollectionConfig>) =>
  fixtureCollections().map((collection) =>
    collection.slug === "pages" ? Object.assign(collection, patch) : collection,
  );

describe("uploads", () => {
  const PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );
  const file = (name: string) => ({ data: PNG, mimetype: "image/png", name, size: PNG.length });
  const staticDir = mkdtempSync(path.join(tmpdir(), "roles-lifecycle-media-"));
  const onDisk = () => readdirSync(staticDir).sort();

  let context: TestPayload;
  let users: Record<"createOnly" | "editor" | "unpublishOnly" | "updateOnly", Actor>;

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
      name: "lifecycle-surfaces-uploads",
      roles: {
        ...defaultRolesOptions(),
        collections: ["users", "pages", "posts", "notes", "media"],
      },
    });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    const mediaUser = async (key: string, actions: string[]) =>
      memberWith(
        payload,
        key,
        await seedRole(payload, key, { collections: { media: { actions } } }),
      );
    users = {
      createOnly: await mediaUser("create-only", ["read", "create"]),
      editor: await mediaUser("editor", ["read", "update", "publish", "unpublish"]),
      unpublishOnly: await mediaUser("unpublish-only", ["read", "unpublish"]),
      updateOnly: await mediaUser("update-only", ["read", "update"]),
    };
  });

  afterAll(async () => {
    await context.destroy();
    rmSync(staticDir, { force: true, recursive: true });
  });

  const seedMedia = async (name: string, status: "draft" | "published") => {
    const doc = await context.payload.create({
      collection: "media",
      data: { _status: status, alt: name },
      file: file(`${name}.png`),
    });
    return doc.id;
  };

  const mediaRow = (id: number | string) => storedRow(context.payload, "media", id);

  const multipartPatch = async (actor: Actor, id: number | string, name: string, body: object) => {
    const form = new FormData();
    form.append("file", new Blob([PNG], { type: "image/png" }), name);
    form.append("_payload", JSON.stringify(body));
    const response = await handleEndpoints({
      config: context.config,
      payloadInstanceCacheKey: context.key,
      request: new Request(`http://localhost/api/media/${id}`, {
        body: form,
        headers: { Authorization: `JWT ${await login(context.payload, actor.email)}` },
        method: "PATCH",
      }),
    });
    return response.status;
  };

  test("update-only cannot publish a draft over REST multipart; no file is written", async () => {
    const id = await seedMedia("rest-draft", "draft");
    const disk = onDisk();

    expect(
      await multipartPatch(users.updateOnly, id, "rest-published.png", {
        _status: "published",
        alt: "published",
      }),
    ).toBe(403);

    expect(onDisk()).toEqual(disk);
    expect(await mediaRow(id)).toEqual(
      expect.objectContaining({ _status: "draft", alt: "rest-draft", filename: "rest-draft.png" }),
    );
  });

  test("update-only cannot replace the file of a published doc without a draft; no file changes", async () => {
    const id = await seedMedia("local-published", "published");
    const disk = onDisk();

    await rejectsWith(
      context.payload.update({
        collection: "media",
        data: { alt: "replaced" },
        file: file("local-replaced.png"),
        id,
        overrideAccess: false,
        user: users.updateOnly,
      }),
      "Forbidden",
    );

    expect(onDisk()).toEqual(disk);
    expect(await mediaRow(id)).toEqual(
      expect.objectContaining({
        _status: "published",
        alt: "local-published",
        filename: "local-published.png",
      }),
    );
  });

  test("unpublish-only can unpublish a published upload by status alone; files stay", async () => {
    const id = await seedMedia("unpublish", "published");
    const disk = onDisk();

    await as(context.payload, users.unpublishOnly).update({
      collection: "media",
      data: { _status: "draft" },
      id,
    });

    expect(await mediaRow(id)).toEqual(
      expect.objectContaining({ _status: "draft", alt: "unpublish", filename: "unpublish.png" }),
    );
    expect(onDisk()).toEqual(disk);
  });

  test("update, publish and unpublish together can replace the file of a published upload", async () => {
    const id = await seedMedia("replace-me", "published");

    await context.payload.update({
      collection: "media",
      data: { alt: "replaced" },
      file: file("replacement.png"),
      id,
      overrideAccess: false,
      user: users.editor,
    });

    expect(await mediaRow(id)).toEqual(
      expect.objectContaining({
        _status: "published",
        alt: "replaced",
        filename: "replacement.png",
      }),
    );
    expect(onDisk()).toContain("replacement.png");
  });

  test("create-only cannot create a published upload; no row or file is written", async () => {
    const disk = onDisk();
    const count = async () =>
      (await context.payload.count({ collection: "media", trash: true })).totalDocs;
    const rows = await count();

    await rejectsWith(
      as(context.payload, users.createOnly).create({
        collection: "media",
        data: { _status: "published", alt: "denied" },
        file: file("denied-create.png"),
      }),
      "Forbidden",
    );

    expect(onDisk()).toEqual(disk);
    expect(await count()).toBe(rows);
  });
});

describe("scheduled publish jobs", () => {
  let context: TestPayload;

  beforeAll(async () => {
    context = await createTestPayload({
      collections: withPages({ versions: { drafts: { schedulePublish: true } } }),
      name: "lifecycle-surfaces-jobs",
      plugins: [(config) => ({ ...config, jobs: { ...config.jobs, deleteJobOnComplete: false } })],
    });
    await seedUser(context.payload, { email: "bootstrap@example.com" });
  });

  afterAll(() => context.destroy());

  const page = async (status: "draft" | "published") => {
    const doc = await context.payload.create({
      collection: "pages",
      data: { _status: status, title: `scheduled ${status}` },
    });
    return doc.id;
  };

  const queue = (type: "publish" | "unpublish", id: number | string, actor: Actor) =>
    context.payload.jobs.queue({
      input: {
        doc: { relationTo: "pages", value: id },
        type,
        user: { relationTo: "users", value: actor.id },
      },
      task: "schedulePublish",
    });

  const run = async (jobId: number | string) => {
    await context.payload.jobs.runByID({ id: jobId });
    const job = await context.payload.findByID({
      collection: "payload-jobs",
      depth: 0,
      id: jobId,
    });
    return { error: job.error, hasError: job.hasError };
  };

  const pageRow = (id: number | string) => storedRow(context.payload, "pages", id);

  test("a queued publish by an update and publish holder publishes", async () => {
    const { payload } = context;
    const publisher = await memberWith(
      payload,
      "job-publisher",
      await pagesRole(payload, "job-publisher", ["read", "update", "publish"]),
    );
    const id = await page("draft");

    expect(await run((await queue("publish", id, publisher)).id)).toMatchObject({
      hasError: false,
    });
    expect(await pageRow(id)).toMatchObject({ _status: "published" });
  });

  test("a queued unpublish by an unpublish-only holder unpublishes", async () => {
    const { payload } = context;
    const unpublisher = await memberWith(
      payload,
      "job-unpublisher",
      await pagesRole(payload, "job-unpublisher", ["read", "unpublish"]),
    );
    const id = await page("published");

    expect(await run((await queue("unpublish", id, unpublisher)).id)).toMatchObject({
      hasError: false,
    });
    expect(await pageRow(id)).toMatchObject({ _status: "draft" });
  });

  test("publish is checked at execution time: revoking it after queueing fails the job and writes nothing", async () => {
    const { payload } = context;
    const roleId = await pagesRole(payload, "job-revoked", ["read", "update", "publish"]);
    const publisher = await memberWith(payload, "job-revoked", roleId);
    const id = await page("draft");
    const job = await queue("publish", id, publisher);

    await payload.update({
      collection: "roles",
      data: { permissions: { collections: { pages: { actions: ["read", "update"] } } } },
      id: roleId,
    });

    expect(await run(job.id)).toMatchObject({ hasError: true });
    expect(await pageRow(id)).toMatchObject({ _status: "draft" });
  });

  test("a queued unpublish whose user was deleted before execution fails and writes nothing", async () => {
    const { payload } = context;
    const doomed = await memberWith(
      payload,
      "job-doomed",
      await pagesRole(payload, "job-doomed", ["read", "unpublish"]),
    );
    const id = await page("published");
    const job = await queue("unpublish", id, doomed);

    await payload.delete({ collection: "users", id: doomed.id });

    expect(await run(job.id)).toMatchObject({
      error: { message: "Not Found" },
      hasError: true,
    });
    expect(await pageRow(id)).toMatchObject({ _status: "published" });
  });
});

describe("GraphQL", () => {
  let context: TestPayload;
  let tokens: Record<"createOnly" | "settingsUpdate" | "unpublishOnly" | "updateOnly", string>;

  beforeAll(async () => {
    context = await createTestPayload({ name: "lifecycle-surfaces-graphql" });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    const tokenFor = async (key: string, roleId: number | string) =>
      login(payload, (await memberWith(payload, key, roleId)).email);
    tokens = {
      createOnly: await tokenFor(
        "create-only",
        await pagesRole(payload, "create-only", ["read", "create"]),
      ),
      settingsUpdate: await tokenFor(
        "settings-update",
        await seedRole(payload, "settings-update", {
          globals: { settings: { actions: ["read", "update"] } },
        }),
      ),
      unpublishOnly: await tokenFor(
        "unpublish-only",
        await pagesRole(payload, "unpublish-only", ["read", "unpublish"]),
      ),
      updateOnly: await tokenFor(
        "update-only",
        await pagesRole(payload, "update-only", ["read", "update"]),
      ),
    };
  });

  afterAll(() => context.destroy());

  const page = async (status: "draft" | "published", title: string) => {
    const doc = await context.payload.create({
      collection: "pages",
      data: { _status: status, title },
    });
    return doc.id;
  };

  const updatePage = (
    token: string,
    variables: { id: number | string; data: object; draft: boolean; autosave: boolean },
  ) =>
    graphql(
      context,
      token,
      `
        mutation ($id: Int!, $data: mutationPageUpdateInput!, $draft: Boolean, $autosave: Boolean) {
          updatePage(id: $id, data: $data, draft: $draft, autosave: $autosave) {
            id
          }
        }
      `,
      variables,
    );

  const stored = (id: number | string) => storedRow(context.payload, "pages", id);

  test("update-only can autosave a draft of a published page; the public row is unchanged", async () => {
    const id = await page("published", "gql live");

    const result = await updatePage(tokens.updateOnly, {
      autosave: true,
      data: { title: "gql autosaved" },
      draft: true,
      id,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data?.updatePage).toMatchObject({ id });
    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "published", title: "gql live" }),
    );
  });

  test("update-only cannot publish a draft page", async () => {
    const id = await page("draft", "gql draft");

    const result = await updatePage(tokens.updateOnly, {
      autosave: false,
      data: { _status: "published" },
      draft: false,
      id,
    });

    expect(result.data?.updatePage).toBeNull();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "draft", title: "gql draft" }),
    );
  });

  test("unpublish-only can unpublish a published page by status alone", async () => {
    const id = await page("published", "gql unpublish");

    const result = await updatePage(tokens.unpublishOnly, {
      autosave: false,
      data: { _status: "draft" },
      draft: false,
      id,
    });

    expect(result.errors).toBeUndefined();
    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "draft", title: "gql unpublish" }),
    );
  });

  test("unpublish-only cannot unpublish while also changing content", async () => {
    const id = await page("published", "gql content");

    const result = await updatePage(tokens.unpublishOnly, {
      autosave: false,
      data: { _status: "draft", title: "gql changed" },
      draft: false,
      id,
    });

    expect(result.data?.updatePage).toBeNull();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "published", title: "gql content" }),
    );
  });

  test("create-only cannot duplicate a published page, which GraphQL always copies as published", async () => {
    const id = await page("published", "gql duplicate");
    const count = async () =>
      (await context.payload.count({ collection: "pages", trash: true })).totalDocs;
    const rows = await count();

    const result = await graphql(
      context,
      tokens.createOnly,
      `
        mutation ($id: Int!) {
          duplicatePage(id: $id, data: {}) {
            id
          }
        }
      `,
      { id },
    );

    expect(result.data?.duplicatePage).toBeNull();
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(await count()).toBe(rows);
  });

  test("update-only can save a draft of a published global; the public row is unchanged", async () => {
    const { payload } = context;
    await payload.updateGlobal({
      data: { _status: "published", siteName: "gql site" },
      slug: "settings",
    });

    const result = await graphql(
      context,
      tokens.settingsUpdate,
      `
        mutation {
          updateSetting(data: { siteName: "gql site draft" }, draft: true) {
            siteName
          }
        }
      `,
    );

    expect(result.errors).toBeUndefined();
    expect(await payload.db.findGlobal({ slug: "settings" })).toMatchObject({
      _status: "published",
      siteName: "gql site",
    });
  });
});

describe("copy to locale", () => {
  let context: TestPayload;
  let users: Record<"publisher" | "updateOnly", Actor>;

  beforeAll(async () => {
    context = await createTestPayload({
      collections: withPages({ fields: [{ localized: true, name: "title", type: "text" }] }),
      name: "lifecycle-surfaces-locale",
      plugins: [
        (config) => ({ ...config, localization: { defaultLocale: "en", locales: ["en", "de"] } }),
      ],
    });
    const { payload } = context;
    await seedUser(payload, { email: "bootstrap@example.com" });
    users = {
      publisher: await memberWith(
        payload,
        "locale-publisher",
        await pagesRole(payload, "locale-publisher", ["read", "update", "publish"]),
      ),
      updateOnly: await memberWith(
        payload,
        "locale-update-only",
        await pagesRole(payload, "locale-update-only", ["read", "update"]),
      ),
    };
  });

  afterAll(() => context.destroy());

  const publishedPage = async (title: string) => {
    const doc = await context.payload.create({
      collection: "pages",
      data: { _status: "published", title },
      locale: "en",
    });
    return doc.id;
  };

  const copyToGerman = async (actor: Actor, id: number | string) =>
    copyDataFromLocale({
      collectionSlug: "pages",
      docID: id,
      fromLocale: "en",
      req: await createLocalReq({ user: actor }, context.payload),
      toLocale: "de",
    });

  const stored = (id: number | string) =>
    context.payload.db.findOne({
      collection: "pages",
      locale: "all",
      where: { id: { equals: id } },
    });

  const latestVersionTitle = async (id: number | string) => {
    const { docs } = await context.payload.db.findVersions({
      collection: "pages",
      limit: 1,
      locale: "all",
      pagination: false,
      sort: "-updatedAt",
      where: { and: [{ parent: { equals: id } }, { latest: { equals: true } }] },
    });
    return docs[0]?.version.title;
  };

  test("update-only cannot copy into a published page, which would publish the copy", async () => {
    const id = await publishedPage("Locale denied");

    await rejectsWith(copyToGerman(users.updateOnly, id), "Forbidden");

    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "published", title: { en: "Locale denied" } }),
    );
  });

  test("update and publish can copy into a published page; both locales are published", async () => {
    const id = await publishedPage("Locale published");

    await copyToGerman(users.publisher, id);

    expect(await stored(id)).toEqual(
      expect.objectContaining({
        _status: "published",
        title: { de: "Locale published", en: "Locale published" },
      }),
    );
  });

  test("update-only can copy into a page with a pending draft; only the draft gets the copy", async () => {
    const id = await publishedPage("Locale live");
    await context.payload.update({
      collection: "pages",
      data: { title: "Locale draft" },
      draft: true,
      id,
      locale: "en",
    });

    await copyToGerman(users.updateOnly, id);

    expect(await stored(id)).toEqual(
      expect.objectContaining({ _status: "published", title: { en: "Locale live" } }),
    );
    expect(await latestVersionTitle(id)).toEqual({ de: "Locale draft", en: "Locale draft" });
  });
});
