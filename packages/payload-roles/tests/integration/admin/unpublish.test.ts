import { createLocalReq, type Payload } from "payload";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { type ResourceId, UnpublishControl, UnpublishSlot } from "@codlume/payload-roles";
import { UnpublishDocument } from "@codlume/payload-roles/client";
import { UnpublishButton } from "@payloadcms/ui";

import { unpublishTarget } from "../../../src/admin/client/unpublish-request.ts";
import { type Actor, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

vi.mock("@codlume/payload-roles/client", () => ({ UnpublishDocument: vi.fn() }));
vi.mock("@payloadcms/ui", () => ({ UnpublishButton: vi.fn() }));

const PAGES: ResourceId = "collections:pages";
const SETTINGS: ResourceId = "globals:settings";
const FULL = ["read", "update", "publish", "unpublish", "readVersions"];

const collections = () => {
  const all = fixtureCollections();
  const pages = all.find(({ slug }) => slug === "pages");
  if (pages) {
    pages.admin = { components: { edit: { beforeDocumentControls: ["app#Control"] } } };
  }
  return all;
};

let context: TestPayload;
let disabled: TestPayload;
let pageId: number | string;
let actors: Record<"full" | "publisher" | "readUnpublish" | "superAdmin" | "updateOnly", Actor>;

const member = async (payload: Payload, key: string, actions: string[]) => {
  const role = await seedRole(payload, key, {
    collections: { pages: { actions } },
    globals: { settings: { actions } },
  });
  return seedUser(payload, { email: `${key}@example.com`, roles: [role] });
};

const publish = async (payload: Payload) => {
  const page = await payload.create({
    collection: "pages",
    data: { _status: "published", title: "Live" },
  });
  await payload.updateGlobal({
    data: { _status: "published", siteName: "Live" },
    slug: "settings",
  });
  return page.id;
};

beforeAll(async () => {
  context = await createTestPayload({ collections: collections(), name: "admin-unpublish" });
  disabled = await createTestPayload({
    name: "admin-unpublish-disabled",
    roles: { ...defaultRolesOptions(), enabled: false },
  });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  actors = {
    full: await member(payload, "full", FULL),
    publisher: await member(payload, "publisher", ["read", "update", "publish"]),
    readUnpublish: await member(payload, "read-unpublish", ["read", "unpublish"]),
    superAdmin: await seedUser(payload, { email: "admin@example.com", superAdmin: true }),
    updateOnly: await member(payload, "update-only", ["read", "update"]),
  };
  pageId = await publish(payload);
  await publish(disabled.payload);
});

afterAll(async () => {
  await context.destroy();
  await disabled.destroy();
});

/** The `user` prop Payload passes to document slots: the viewer's own read of themselves. */
const viewerProp = async (payload: Payload, actor: Actor) => ({
  ...(await payload.findByID({
    collection: "users",
    depth: 0,
    id: actor.id,
    overrideAccess: false,
    user: actor,
  })),
  collection: "users",
});

type Viewer = Awaited<ReturnType<typeof viewerProp>>;

const rendered = async (
  payload: Payload,
  resource: ResourceId,
  user: Viewer | undefined,
  id?: number | string,
) => {
  const props = {
    i18n: (await createLocalReq({}, payload)).i18n,
    payload,
    resource,
    ...(id !== undefined && { id }),
    ...(user && { user }),
  };
  const [slot, control] = await Promise.all([UnpublishSlot(props), UnpublishControl(props)]);
  return {
    slot: slot && (slot.type === UnpublishButton ? "stock" : slot.type),
    control: control && (control.type === UnpublishDocument ? "control" : control.type),
  };
};

const OFFERED = { slot: null, control: "control" };
const HIDDEN = { slot: null, control: null };
const STOCK = { slot: "stock", control: null };

test.each([
  ["pages", PAGES],
  ["settings", SETTINGS],
] as const)("on %s only unpublish holders are offered Unpublish", async (_name, resource) => {
  const { payload } = context;
  const id = resource === PAGES ? pageId : undefined;
  const as = async (actor: Actor) =>
    rendered(payload, resource, await viewerProp(payload, actor), id);

  expect(await as(actors.readUnpublish)).toEqual(OFFERED);
  expect(await as(actors.publisher)).toEqual(HIDDEN);
  expect(await as(actors.full)).toEqual(OFFERED);
  expect(await as(actors.updateOnly)).toEqual(HIDDEN);
  expect(await as(actors.superAdmin)).toEqual(OFFERED);
  expect(await rendered(payload, resource, undefined, id)).toEqual(STOCK);
});

test("the stored user row decides, not the user prop", async () => {
  const { payload } = context;
  const { publisher, readUnpublish } = actors;

  const claimsAdmin = { ...(await viewerProp(payload, publisher)), roles: [], superAdmin: true };
  expect(await rendered(payload, PAGES, claimsAdmin, pageId)).toEqual(HIDDEN);

  const claimsNothing = { ...(await viewerProp(payload, readUnpublish)), roles: [] };
  expect(await rendered(payload, PAGES, claimsNothing, pageId)).toEqual(OFFERED);

  const otherCollection = { ...(await viewerProp(payload, readUnpublish)), collection: "admins" };
  expect(await rendered(payload, PAGES, otherCollection, pageId)).toEqual(STOCK);

  const deleted = { ...(await viewerProp(payload, readUnpublish)), id: 9999 };
  expect(await rendered(payload, PAGES, deleted, pageId)).toEqual(STOCK);
});

test("the viewer's stored roles are ids, which the resolver reloads", async () => {
  const row = await context.payload.db.findOne({
    collection: "users",
    where: { id: { equals: actors.full.id } },
  });
  expect(row).toMatchObject({ roles: [expect.any(Number)] });
});

test("a resource the plugin does not manage keeps stock", async () => {
  const { payload } = context;
  const viewer = await viewerProp(payload, actors.full);
  expect(await rendered(payload, "collections:missing", viewer, pageId)).toEqual(STOCK);
});

test("drafts resources carry both slots, after the app's own controls", () => {
  const { config } = context;
  const edit = (slug: string) =>
    config.collections.find((collection) => collection.slug === slug)?.admin.components?.edit;

  expect(edit("pages")).toMatchObject({
    UnpublishButton: {
      path: "@codlume/payload-roles#UnpublishSlot",
      serverProps: { resource: PAGES },
    },
    beforeDocumentControls: [
      "app#Control",
      { path: "@codlume/payload-roles#UnpublishControl", serverProps: { resource: PAGES } },
    ],
  });
  expect(
    config.globals.find(({ slug }) => slug === "settings")?.admin.components?.elements,
  ).toMatchObject({
    UnpublishButton: {
      path: "@codlume/payload-roles#UnpublishSlot",
      serverProps: { resource: SETTINGS },
    },
    beforeDocumentControls: [
      { path: "@codlume/payload-roles#UnpublishControl", serverProps: { resource: SETTINGS } },
    ],
  });
  expect(edit("posts")?.UnpublishButton).toBeUndefined();
  expect(edit("posts")?.beforeDocumentControls).toBeUndefined();
  expect(edit("roles")?.UnpublishButton).toBeUndefined();
  expect(edit("roles")?.beforeDocumentControls).toBeUndefined();
});

test("disabled mode keeps stock Unpublish everywhere", async () => {
  const { config, payload } = disabled;
  const page = await payload.find({ collection: "pages", limit: 1 });
  const pages = config.collections.find(({ slug }) => slug === "pages");
  const settings = config.globals.find(({ slug }) => slug === "settings");

  expect(pages?.admin.components?.edit?.UnpublishButton).toBeDefined();
  expect(settings?.admin.components?.elements?.UnpublishButton).toBeUndefined();
  expect(settings?.admin.components?.elements?.beforeDocumentControls).toBeUndefined();

  const viewer = await viewerProp(payload, await member(payload, "holder", FULL));
  expect(await rendered(payload, PAGES, viewer, page.docs[0]?.id)).toEqual(STOCK);
  expect(await rendered(payload, SETTINGS, viewer)).toEqual(STOCK);
});

test("the stock request unpublishes the doc and the global for a full unpublisher", async () => {
  const { payload } = context;
  const id = await publish(payload);
  const send = rest(context, await login(payload, "full@example.com"));
  const targets = [
    unpublishTarget({ api: "", serverURL: "", collectionSlug: "pages", id }),
    unpublishTarget({ api: "", serverURL: "", globalSlug: "settings" }),
  ];

  const statuses = await Promise.all(
    targets.map(async (target) =>
      target
        ? (await send(target.method.toUpperCase(), target.url, { _status: "draft" })).status
        : null,
    ),
  );
  expect(statuses).toEqual([200, 200]);
  expect(await payload.findByID({ collection: "pages", id })).toMatchObject({
    _status: "draft",
  });
  expect(await payload.findGlobal({ slug: "settings" })).toMatchObject({ _status: "draft" });
});
