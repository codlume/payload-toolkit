// An app `beforeOperation` hook may hand Payload a new request. A write to a collection or a
// global with drafts is then still judged on the grants of the user Payload acts for, and only a
// write that set `overrideAccess` is trusted.
import {
  type CollectionBeforeOperationHook,
  createLocalReq,
  type GlobalBeforeOperationHook,
  type PayloadRequest,
} from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type Actor, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  fixtureCollections,
  fixtureGlobals,
  type TestPayload,
} from "../../helpers/payload.ts";

/**
 * How the app hook hands over the new request: on a copy of args, on new args, or in place. Both
 * of the last two at once leaves nothing that ties the final args to the request the operation
 * began on.
 */
const HANDOVERS = ["copy", "rebuilt", "in place", "in place and rebuilt"] as const;

const STATUS = "_status";
const TRASHED = "2026-01-01T00:00:00.000Z";

const state: {
  handover: (typeof HANDOVERS)[number] | null;
  /** Whose request the hook hands over; the user of the request it replaces when null. */
  user: Actor | null;
} = { handover: null, user: null };

const handOver = async <Args extends object>(
  args: Args,
  operation: string,
  req: PayloadRequest,
) => {
  const { handover } = state;
  if (handover === null || !["create", "restoreVersion", "update"].includes(operation)) {
    return args;
  }
  const user = state.user ?? req.user;
  const swapped = await createLocalReq(user ? { user } : {}, req.payload);
  if (handover === "in place") {
    return Object.assign(args, { req: swapped });
  }
  if (handover === "in place and rebuilt") {
    Object.assign(args, { req: swapped });
  }
  const next = { ...args, req: swapped };
  if (handover !== "copy") {
    // An app that builds its own args object copies the string keys it knows.
    for (const key of Object.getOwnPropertySymbols(next)) {
      Reflect.deleteProperty(next, key);
    }
  }
  return next;
};

const swapPageRequest: CollectionBeforeOperationHook = ({ args, operation, req }) =>
  handOver(args, operation, req);

const swapSettingsRequest: GlobalBeforeOperationHook = ({ args, operation, req }) => {
  const source: unknown = args;
  return typeof source === "object" && source !== null ? handOver(source, operation, req) : source;
};

let context: TestPayload;
let users: Record<"drafter" | "publisher" | "superAdmin", Actor>;

beforeAll(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "pages"
        ? Object.assign(collection, { hooks: { beforeOperation: [swapPageRequest] } })
        : collection,
    ),
    globals: fixtureGlobals().map((global) =>
      Object.assign(global, { hooks: { beforeOperation: [swapSettingsRequest] } }),
    ),
    name: "lifecycle-swapped-request",
  });
  const { payload } = context;
  const superAdmin = await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, actions: string[]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [
        await seedRole(payload, key, {
          collections: { pages: { actions } },
          globals: { settings: { actions } },
        }),
      ],
    });
  users = {
    drafter: await member("drafter", ["read", "update", "readVersions"]),
    publisher: await member("publisher", ["read", "update", "publish", "readVersions"]),
    superAdmin,
  };
});

beforeEach(() => {
  state.handover = null;
  state.user = null;
});

afterAll(() => context.destroy());

const tick = () => new Promise((resolve) => setTimeout(resolve, 2));

const draftPage = async (title: string) =>
  (await context.payload.create({ collection: "pages", data: { title }, draft: true })).id;

const publishedPage = async (title: string) =>
  (await context.payload.create({ collection: "pages", data: { [STATUS]: "published", title } }))
    .id;

/** A draft page and the id of the published version it was unpublished from. */
const unpublishedPage = async (title: string) => {
  const { payload } = context;
  const id = await publishedPage(title);
  await tick();
  const { docs } = await payload.db.findVersions({
    collection: "pages",
    limit: 1,
    pagination: false,
    sort: "-updatedAt",
    where: { parent: { equals: id } },
  });
  await payload.update({ collection: "pages", data: { [STATUS]: "draft" }, id });
  await tick();
  return { id, version: docs[0]?.id ?? "missing" };
};

/** The page as its latest version holds it, trashed or not. */
const latestPage = async (id: number | string) => {
  const page = await context.payload.findByID({
    collection: "pages",
    draft: true,
    id,
    trash: true,
  });
  return { [STATUS]: page[STATUS], deletedAt: page.deletedAt ?? null, title: page.title };
};

const settingsAre = async (data: { [STATUS]: "draft" | "published"; siteName: string }) => {
  await context.payload.updateGlobal({ data, slug: "settings" });
};

/** The settings global as its latest version holds it. */
const latestSettings = async () => {
  const settings = await context.payload.findGlobal({ draft: true, slug: "settings" });
  return { [STATUS]: settings[STATUS], siteName: settings.siteName };
};

describe.each(HANDOVERS)("when an app hook swaps the request (%s)", (handover) => {
  test("a member holding update saves a draft page over the Local API", async () => {
    const id = await draftPage(`local draft, ${handover}`);
    state.handover = handover;

    await context.payload.update({
      collection: "pages",
      data: { title: "saved" },
      draft: true,
      id,
      overrideAccess: false,
      user: users.drafter,
    });

    expect(await latestPage(id)).toEqual({ [STATUS]: "draft", deletedAt: null, title: "saved" });
  });

  test("a member holding update saves a draft page over REST", async () => {
    const id = await draftPage(`rest draft, ${handover}`);
    const call = rest(context, await login(context.payload, users.drafter.email));
    state.handover = handover;

    const response = await call("PATCH", `/pages/${id}?draft=true`, { title: "saved" });

    expect(await latestPage(id)).toEqual({ [STATUS]: "draft", deletedAt: null, title: "saved" });
    expect(response.status).toBe(200);
  });

  test("a member without publish cannot publish a page over the Local API", async () => {
    const id = await draftPage(`local publish, ${handover}`);
    state.handover = handover;

    const attempt = context.payload.update({
      collection: "pages",
      data: { [STATUS]: "published" },
      id,
      overrideAccess: false,
      user: users.drafter,
    });
    await attempt.catch(() => undefined);

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "draft" });
    await rejectsWith(attempt, "Forbidden");
  });

  test("a member without publish cannot publish a page over REST", async () => {
    const id = await draftPage(`rest publish, ${handover}`);
    const call = rest(context, await login(context.payload, users.drafter.email));
    state.handover = handover;

    const response = await call("PATCH", `/pages/${id}`, { [STATUS]: "published" });

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "draft" });
    expect(response.status).toBe(403);
  });

  test("a member holding publish publishes a page", async () => {
    const id = await draftPage(`publisher, ${handover}`);
    state.handover = handover;

    await context.payload.update({
      collection: "pages",
      data: { [STATUS]: "published" },
      id,
      overrideAccess: false,
      user: users.publisher,
    });

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "published" });
  });

  test("a trusted Local API write publishes and trashes a page", async () => {
    const id = await draftPage(`trusted, ${handover}`);
    state.handover = handover;

    await context.payload.update({ collection: "pages", data: { [STATUS]: "published" }, id });
    await context.payload.update({ collection: "pages", data: { deletedAt: TRASHED }, id });

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "published", deletedAt: TRASHED });
  });

  test("a member holding publish restores a published version of a page", async () => {
    const { id, version } = await unpublishedPage(`restore, ${handover}`);
    state.handover = handover;

    await context.payload.restoreVersion({
      collection: "pages",
      id: version,
      overrideAccess: false,
      user: users.publisher,
    });

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "published" });
  });

  test("a member without publish cannot restore a published version of a page", async () => {
    const { id, version } = await unpublishedPage(`restore refused, ${handover}`);
    state.handover = handover;

    const attempt = context.payload.restoreVersion({
      collection: "pages",
      id: version,
      overrideAccess: false,
      user: users.drafter,
    });
    await attempt.catch(() => undefined);

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "draft" });
    await rejectsWith(attempt, "Forbidden");
  });

  test("a member holding update saves a draft of the global", async () => {
    await settingsAre({ [STATUS]: "draft", siteName: "before" });
    state.handover = handover;

    await context.payload.updateGlobal({
      data: { siteName: "saved" },
      draft: true,
      overrideAccess: false,
      slug: "settings",
      user: users.drafter,
    });

    expect(await latestSettings()).toEqual({ [STATUS]: "draft", siteName: "saved" });
  });

  test("a member without publish cannot publish the global", async () => {
    await settingsAre({ [STATUS]: "draft", siteName: "before" });
    state.handover = handover;

    const attempt = context.payload.updateGlobal({
      data: { [STATUS]: "published", siteName: "published" },
      overrideAccess: false,
      slug: "settings",
      user: users.drafter,
    });
    await attempt.catch(() => undefined);

    expect(await latestSettings()).toEqual({ [STATUS]: "draft", siteName: "before" });
    await rejectsWith(attempt, "Forbidden");
  });

  test("a trusted Local API write publishes the global", async () => {
    await settingsAre({ [STATUS]: "draft", siteName: "before" });
    state.handover = handover;

    await context.payload.updateGlobal({
      data: { [STATUS]: "published", siteName: "trusted" },
      slug: "settings",
    });

    expect(await latestSettings()).toEqual({ [STATUS]: "published", siteName: "trusted" });
  });
});

// Payload goes on with the new request only for a collection create or update. A restore and a
// global write keep checking access for the user who began them, so that user is the one judged.
describe.each(HANDOVERS)("when the new request is another user's (%s)", (handover) => {
  test("a page update handed a member's request is judged as that member's", async () => {
    const id = await publishedPage(`as drafter, ${handover}`);
    state.handover = handover;
    state.user = users.drafter;

    const attempt = context.payload.update({
      collection: "pages",
      data: { title: "live edit" },
      id,
      overrideAccess: false,
      user: users.publisher,
    });
    await attempt.catch(() => undefined);

    expect(await latestPage(id)).toMatchObject({ title: `as drafter, ${handover}` });
    await rejectsWith(attempt, "Forbidden");
  });

  test("a member's edit of the published global stays refused when handed a super admin's request", async () => {
    await settingsAre({ [STATUS]: "published", siteName: "live" });
    state.handover = handover;
    state.user = users.superAdmin;

    const attempt = context.payload.updateGlobal({
      data: { siteName: "live edit" },
      overrideAccess: false,
      slug: "settings",
      user: users.drafter,
    });
    await attempt.catch(() => undefined);

    expect(await latestSettings()).toEqual({ [STATUS]: "published", siteName: "live" });
    await rejectsWith(attempt, "Forbidden");
  });

  test("a publisher's restore of a published version goes through when handed a lesser member's request", async () => {
    const { id, version } = await unpublishedPage(`restore as publisher, ${handover}`);
    state.handover = handover;
    state.user = users.drafter;

    await context.payload.restoreVersion({
      collection: "pages",
      id: version,
      overrideAccess: false,
      user: users.publisher,
    });

    expect(await latestPage(id)).toMatchObject({ [STATUS]: "published" });
  });
});
