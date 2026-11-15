import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeOperationHook,
  type CollectionConfig,
  updateByIDOperation,
  updateOperation,
} from "payload";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import { type Actor, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

type Nested = "bulk" | "same-document";

/** How the nested trusted operation differs from the outer write it runs inside. */
type Variant = "draft" | "outsider" | "plain" | "super-admin";

let context: TestPayload;
let users: Record<"articles" | "bins" | "superAdmin", Actor>;
let variant: Variant = "plain";
let nested: null | Nested = null;
/** Whether the alias hook returns a freshly built args object instead of `{ ...args }`. */
let freshArgs = false;
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
    const nestedReq =
      variant === "super-admin"
        ? { ...req, user: { ...users.superAdmin, collection: "users" } }
        : variant === "outsider"
          ? { ...req, user: null }
          : req;
    const shared = {
      collection,
      data: {},
      depth: 0,
      disableTransaction: true,
      draft: variant === "draft",
      overrideAccess: true,
      req: nestedReq,
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
      const resolved = { ...args, id: found?.id ?? id };
      if (freshArgs) {
        for (const key of Object.getOwnPropertySymbols(resolved)) {
          Reflect.deleteProperty(resolved, key);
        }
      }
      return resolved;
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
  const superAdmin = await seedUser(payload, { email: "bootstrap@example.com" });
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
    superAdmin,
  };
  await payload.create({ collection: "bins", data: { title: "unrelated" } });
  await payload.create({
    collection: "articles",
    data: { _status: "published", id: "unrelated-article", title: "unrelated" },
  });
});

afterAll(() => context.destroy());

beforeEach(() => {
  nested = null;
  variant = "plain";
  freshArgs = false;
});

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

describe("a nested trusted operation that is laxer than the outer write it runs inside", () => {
  const variants: readonly Variant[] = ["draft", "super-admin", "outsider"];
  const cases = variants.flatMap((current) => MODES.map((mode) => ({ current, mode })));

  test.each(cases)(
    "an update-only member's aliased live edit stays refused over the Local API ($current, $mode)",
    async ({ current, mode }) => {
      const id = await article(`lax local ${current} ${mode}`);
      nested = mode;
      variant = current;

      await rejectsWith(
        context.payload.update({
          collection: "articles",
          data: { title: "edited without publish" },
          id: `slug:lax local ${current} ${mode}`,
          overrideAccess: false,
          user: users.articles,
        }),
        "Forbidden",
      );
      nested = null;
      variant = "plain";

      expect(await articleTitle(id)).toBe(`lax local ${current} ${mode}`);
    },
  );

  test.each(cases)(
    "an update-only member's aliased live edit stays refused over REST ($current, $mode)",
    async ({ current, mode }) => {
      const id = await article(`lax rest ${current} ${mode}`);
      const api = rest(context, await login(context.payload, users.articles.email));
      nested = mode;
      variant = current;

      const response = await api(
        "PATCH",
        `/articles/${encodeURIComponent(`slug:lax rest ${current} ${mode}`)}`,
        { title: "edited without publish" },
      );
      nested = null;
      variant = "plain";

      expect(response.status, "the live edit needs publish").toBe(403);
      expect(await articleTitle(id)).toBe(`lax rest ${current} ${mode}`);
    },
  );

  test.each(cases)(
    "an update-only member cannot restore a trashed bin by a spelled id over the Local API ($current, $mode)",
    async ({ current, mode }) => {
      const id = await bin(`lax bin ${current} ${mode}`);
      nested = mode;
      variant = current;

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
      nested = null;
      variant = "plain";

      expect((await binRow(id))?.deletedAt, "the bin stays in the trash").toBe(TRASHED);
    },
  );
});

describe("a trusted write through an id an app hook rewrites", () => {
  test.each([false, true])(
    "a default Local API update by an app alias is stored (fresh args object: %s)",
    async (fresh) => {
      const id = await article(`trusted alias ${String(fresh)}`);
      freshArgs = fresh;

      await context.payload.update({
        collection: "articles",
        data: { title: `trusted alias edited ${String(fresh)}` },
        id: `slug:trusted alias ${String(fresh)}`,
      });

      expect(await articleTitle(id)).toBe(`trusted alias edited ${String(fresh)}`);
    },
  );

  test("a default Local API restore from trash by a spelled id is stored", async () => {
    const id = await bin("trusted spelled");

    await context.payload.update({
      collection: "bins",
      data: { deletedAt: null },
      id: `${String(id)}e0`,
      trash: true,
    });

    expect((await binRow(id))?.deletedAt ?? null).toBeNull();
  });

  test("an update-only member's aliased live edit stays refused when the alias hook builds fresh args", async () => {
    const id = await article("member fresh alias");
    freshArgs = true;
    nested = "same-document";
    variant = "draft";

    await rejectsWith(
      context.payload.update({
        collection: "articles",
        data: { title: "edited without publish" },
        id: "slug:member fresh alias",
        overrideAccess: false,
        user: users.articles,
      }),
      "Forbidden",
    );

    expect(await articleTitle(id)).toBe("member fresh alias");
  });
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
