import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  updateByIDOperation,
  updateOperation,
} from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

type Nested = "bulk" | "same-document";

let context: TestPayload;
let users: Record<"articles" | "bins", Actor>;
let nested: null | Nested = null;
const TRASHED = "2026-01-01T00:00:00.000Z";

/** An app hook that runs a direct trusted operation covering the document being written. */
const directTrusted =
  (slug: "articles" | "bins"): CollectionBeforeChangeHook =>
  async ({ data, originalDoc, req }) => {
    const collection = req.payload.collections[slug];
    const mode = nested;
    if (!collection || !mode || !req.user || req.context.nestedRan === true) {
      return data;
    }
    req.context.nestedRan = true;
    const shared = {
      collection,
      data: {},
      depth: 0,
      disableTransaction: true,
      overrideAccess: true,
      req,
      trash: slug === "bins",
    };
    if (mode === "same-document" && originalDoc) {
      await updateByIDOperation({ ...shared, id: originalDoc.id });
    } else {
      await updateOperation({ ...shared, where: { title: { equals: "unrelated" } } });
    }
    return data;
  };

/** An app alias: `slug:<title>` names the article with that title. */
const resolveAlias: CollectionBeforeOperationHook = async ({ args, req }) => {
  const source: unknown = args;
  if (typeof source === "object" && source !== null && "id" in source) {
    const id: unknown = source.id;
    if (typeof id === "string" && id.startsWith("slug:")) {
      const found = await req.payload.db.findOne<{ id: string }>({
        collection: "articles",
        req,
        where: { title: { equals: id.slice("slug:".length) } },
      });
      return { ...args, id: found?.id ?? id };
    }
  }
  return args;
};

const collections = (): CollectionConfig[] => [
  ...fixtureCollections(),
  {
    fields: [{ name: "title", type: "text" }],
    hooks: { beforeChange: [directTrusted("bins")] },
    slug: "bins",
    trash: true,
  },
  {
    fields: [
      { name: "id", type: "text" },
      { name: "title", type: "text" },
    ],
    hooks: { beforeChange: [directTrusted("articles")], beforeOperation: [resolveAlias] },
    slug: "articles",
    versions: { drafts: true },
  },
];

beforeAll(async () => {
  context = await createTestPayload({
    collections: collections(),
    name: "lifecycle-rewritten-id",
    roles: {
      ...defaultRolesOptions(),
      collections: ["users", "pages", "posts", "notes", "bins", "articles"],
    },
  });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, permissions: Parameters<typeof seedRole>[2]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [await seedRole(payload, key, permissions)],
    });
  users = {
    articles: await member("articles-update", {
      collections: { articles: { actions: ["read", "update"] } },
    }),
    bins: await member("bins-update", { collections: { bins: { actions: ["read", "update"] } } }),
  };
  await payload.create({ collection: "bins", data: { title: "unrelated" } });
  await payload.create({
    collection: "articles",
    data: { _status: "published", id: "unrelated-article", title: "unrelated" },
  });
});

afterAll(() => context.destroy());

const bin = async (title: string) =>
  (await context.payload.create({ collection: "bins", data: { deletedAt: TRASHED, title } })).id;

const binRow = async (id: number | string) =>
  context.payload.db.findOne<{ deletedAt?: unknown; id: number | string }>({
    collection: "bins",
    where: { id: { equals: id } },
  });

const article = async (title: string) =>
  (
    await context.payload.create({
      collection: "articles",
      data: { _status: "published", id: `article-${title.replaceAll(" ", "-")}`, title },
    })
  ).id;

const articleTitle = async (id: number | string) =>
  (
    await context.payload.db.findOne<{ id: number | string; title?: unknown }>({
      collection: "articles",
      where: { id: { equals: id } },
    })
  )?.title;

const MODES: readonly Nested[] = ["same-document", "bulk"];

describe("an outer write whose id differs from the stored id, around a direct trusted operation", () => {
  test.each(MODES.flatMap((mode) => ["e0", "."].map((suffix) => ({ mode, suffix }))))(
    "an update-only member cannot restore a trashed bin by id + '$suffix' over the Local API ($mode)",
    async ({ mode, suffix }) => {
      const id = await bin(`bin ${mode} ${suffix}`);
      nested = mode;

      await rejectsWith(
        context.payload.update({
          collection: "bins",
          data: { deletedAt: null },
          id: `${String(id)}${suffix}`,
          overrideAccess: false,
          trash: true,
          user: users.bins,
        }),
        "Forbidden",
      );
      nested = null;

      expect((await binRow(id))?.deletedAt, "the bin stays in the trash").toBe(TRASHED);
    },
  );

  test.each(MODES)(
    "an update-only member cannot edit a live article through an app id alias over the Local API (%s)",
    async (mode) => {
      const id = await article(`alias local ${mode}`);
      nested = mode;

      await rejectsWith(
        context.payload.update({
          collection: "articles",
          data: { title: "edited without publish" },
          id: `slug:alias local ${mode}`,
          overrideAccess: false,
          user: users.articles,
        }),
        "Forbidden",
      );
      nested = null;

      expect(await articleTitle(id)).toBe(`alias local ${mode}`);
    },
  );

  test.each(MODES)(
    "an update-only member cannot edit a live article through an app id alias over REST (%s)",
    async (mode) => {
      const id = await article(`alias rest ${mode}`);
      const api = rest(context, await login(context.payload, users.articles.email));
      nested = mode;

      const response = await api(
        "PATCH",
        `/articles/${encodeURIComponent(`slug:alias rest ${mode}`)}`,
        {
          title: "edited without publish",
        },
      );
      nested = null;

      expect(response.status, "the live edit needs publish").toBe(403);
      expect(await articleTitle(id)).toBe(`alias rest ${mode}`);
    },
  );
});

describe("controls without the nested trusted operation", () => {
  test("the spelled-id restore from trash is refused", async () => {
    const id = await bin("control bin");
    await rejectsWith(
      context.payload.update({
        collection: "bins",
        data: { deletedAt: null },
        id: `${String(id)}e0`,
        overrideAccess: false,
        trash: true,
        user: users.bins,
      }),
      "Forbidden",
    );
    expect((await binRow(id))?.deletedAt).toBe(TRASHED);
  });

  test("the aliased live edit is refused", async () => {
    const id = await article("control alias");
    await rejectsWith(
      context.payload.update({
        collection: "articles",
        data: { title: "edited without publish" },
        id: "slug:control alias",
        overrideAccess: false,
        user: users.articles,
      }),
      "Forbidden",
    );
    expect(await articleTitle(id)).toBe("control alias");
  });
});
