// Trash, restore-from-trash, permanent delete and bulk lifecycle outcomes on the `pages` fixture
// (drafts + trash). Spec rows T1-T5 and U8, plus the bulk partial-commit contract.
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type Actor,
  as,
  login,
  rest,
  type RestResponse,
  seedRole,
  seedUser,
} from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

type RoleName =
  | "deleteMissing"
  | "full"
  | "trashOnly"
  | "trashUpdatePublish"
  | "unpublishOnly"
  | "updateOnly"
  | "updatePublish";

type Seeded = { api: ReturnType<typeof rest>; user: Actor };

const LIFECYCLE = ["read", "create", "update", "publish", "unpublish", "trash", "readVersions"];

let context: TestPayload;
let actors: Record<RoleName, Seeded>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-trash-bulk" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const seed = async (name: RoleName, actions: string[]): Promise<Seeded> => {
    const key = name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const role = await seedRole(payload, key, { collections: { pages: { actions } } });
    const user = await seedUser(payload, { email: `${key}@example.com`, roles: [role] });
    return { api: rest(context, await login(payload, user.email)), user };
  };
  actors = {
    deleteMissing: await seed("deleteMissing", LIFECYCLE),
    full: await seed("full", [...LIFECYCLE, "delete"]),
    trashOnly: await seed("trashOnly", ["read", "trash"]),
    trashUpdatePublish: await seed("trashUpdatePublish", ["read", "trash", "update", "publish"]),
    unpublishOnly: await seed("unpublishOnly", ["read", "unpublish"]),
    updateOnly: await seed("updateOnly", ["read", "update"]),
    updatePublish: await seed("updatePublish", ["read", "update", "publish"]),
  };
});

afterAll(() => context.destroy());

type State = "N" | "P" | "PD" | "TN" | "TP";

/** A fresh page in `state`. PD keeps "<title>" on the main row and "<title> draft" in a newer version. TN/TP are trashed N/P. */
const seedPage = async (state: State, title: string) => {
  const { payload } = context;
  const published = state === "P" || state === "PD" || state === "TP";
  const { id } = await payload.create({
    collection: "pages",
    data: { _status: published ? "published" : "draft", title },
  });
  if (state === "PD") {
    await payload.update({
      collection: "pages",
      data: { title: `${title} draft` },
      draft: true,
      id,
    });
  }
  if (state === "TN" || state === "TP") {
    await payload.update({
      collection: "pages",
      data: { deletedAt: new Date().toISOString() },
      id,
    });
  }
  return id;
};

/** The stored main row, trashed rows included; `null` once permanently deleted. */
const stored = async (id: number | string) => {
  const row = await context.payload.db.findOne<{
    _status?: string;
    deletedAt?: null | string;
    id: number | string;
    title?: string;
  }>({
    collection: "pages",
    where: { id: { equals: id } },
  });
  if (!row) {
    return null;
  }
  const { _status: status, deletedAt, title } = row;
  return { _status: status, deletedAt: deletedAt ?? null, title };
};

const TRASHED = expect.any(String);

/** The ids a bulk REST response lists in `errors`. */
const failedIds = (response: RestResponse) => {
  const errors = response.json?.errors;
  return Array.isArray(errors)
    ? new Set(
        errors.map((entry: unknown) =>
          typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined,
        ),
      )
    : undefined;
};

const NONE = new Set();

const idIn = (...ids: (number | string)[]) => `where[id][in]=${ids.join(",")}`;

/** Local API bulk update as `role`. The `as` helper's updateMany has no `trash` option. */
const updateManyAs = ({
  role,
  ids,
  data,
  trash,
}: {
  role: RoleName;
  ids: (number | string)[];
  data: Record<string, unknown>;
  trash: boolean;
}) =>
  context.payload.update({
    collection: "pages",
    data,
    overrideAccess: false,
    trash,
    user: actors[role].user,
    where: { id: { in: ids } },
  });

describe("T1: move to trash needs trash, not unpublish", () => {
  test.each(["N", "P", "PD"] as const)("trash-only moves %s to trash over REST", async (state) => {
    const id = await seedPage(state, `T1 rest ${state}`);
    const response = await actors.trashOnly.api("PATCH", `/pages/${id}`, {
      deletedAt: new Date().toISOString(),
    });
    expect(response.status).toBe(200);
    expect((await stored(id))?.deletedAt).toEqual(TRASHED);
  });

  test.each(["N", "P", "PD"] as const)("trash-only moves %s to trash over Local", async (state) => {
    const id = await seedPage(state, `T1 local ${state}`);
    await as(context.payload, actors.trashOnly.user).update({
      collection: "pages",
      data: { deletedAt: new Date().toISOString() },
      id,
    });
    expect((await stored(id))?.deletedAt).toEqual(TRASHED);
  });

  test("update-only cannot move a published page to trash", async () => {
    const id = await seedPage("P", "T1 update-only");
    const response = await actors.updateOnly.api("PATCH", `/pages/${id}`, {
      deletedAt: new Date().toISOString(),
    });
    expect(response.status).toBe(403);
    await rejectsWith(
      as(context.payload, actors.updateOnly.user).update({
        collection: "pages",
        data: { deletedAt: new Date().toISOString() },
        id,
      }),
      "Forbidden",
    );
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "T1 update-only",
    });
  });

  test("trash-only moves N, P and PD to trash in one bulk REST request", async () => {
    const ids = [
      await seedPage("N", "T1 bulk N"),
      await seedPage("P", "T1 bulk P"),
      await seedPage("PD", "T1 bulk PD"),
    ];
    const response = await actors.trashOnly.api("PATCH", `/pages?${idIn(...ids)}`, {
      deletedAt: new Date().toISOString(),
    });
    expect(response.status).toBe(200);
    expect(failedIds(response)).toEqual(NONE);
    for (const row of await Promise.all(ids.map(stored))) {
      expect(row?.deletedAt).toEqual(TRASHED);
    }
  });

  test("trash-only moves N, P and PD to trash in one Local updateMany", async () => {
    const ids = [
      await seedPage("N", "T1 many N"),
      await seedPage("P", "T1 many P"),
      await seedPage("PD", "T1 many PD"),
    ];
    const result = await updateManyAs({
      role: "trashOnly",
      ids: ids,
      data: { deletedAt: new Date().toISOString() },
      trash: false,
    });
    expect(result.errors).toEqual([]);
    for (const row of await Promise.all(ids.map(stored))) {
      expect(row?.deletedAt).toEqual(TRASHED);
    }
  });
});

describe("trash-only cannot edit content", () => {
  test("a non-draft title edit of P is denied over REST and Local", async () => {
    const id = await seedPage("P", "Trash-only content");
    expect((await actors.trashOnly.api("PATCH", `/pages/${id}`, { title: "edited" })).status).toBe(
      403,
    );
    await rejectsWith(
      as(context.payload, actors.trashOnly.user).update({
        collection: "pages",
        data: { title: "edited" },
        id,
      }),
      "Forbidden",
    );
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "Trash-only content",
    });
  });

  test("a draft save on P is denied", async () => {
    const id = await seedPage("P", "Trash-only draft");
    const response = await actors.trashOnly.api("PATCH", `/pages/${id}?draft=true`, {
      title: "draft edit",
    });
    expect(response.status).toBe(403);
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "Trash-only draft",
    });
  });
});

describe("T2: restore from trash as draft needs trash", () => {
  test("trash-only restores a trashed published page as draft over bulk REST", async () => {
    const id = await seedPage("TP", "T2 rest");
    const response = await actors.trashOnly.api(
      "PATCH",
      `/pages?trash=true&where[id][equals]=${id}`,
      {
        _status: "draft",
        deletedAt: null,
      },
    );
    expect(response.status).toBe(200);
    expect(failedIds(response)).toEqual(NONE);
    expect(await stored(id)).toEqual({ _status: "draft", deletedAt: null, title: "T2 rest" });
  });

  test("trash-only restores a trashed published page as draft over Local updateMany", async () => {
    const id = await seedPage("TP", "T2 local");
    const result = await updateManyAs({
      role: "trashOnly",
      ids: [id],
      data: { _status: "draft", deletedAt: null },
      trash: true,
    });
    expect(result.errors).toEqual([]);
    expect(await stored(id)).toEqual({ _status: "draft", deletedAt: null, title: "T2 local" });
  });
});

describe("T3: restore from trash as published needs trash and publish", () => {
  test("trash-only is refused before any document is read over bulk REST and the pages stay trashed", async () => {
    const a = await seedPage("TN", "T3 denied a");
    const b = await seedPage("TN", "T3 denied b");
    const response = await actors.trashOnly.api("PATCH", `/pages?trash=true&${idIn(a, b)}`, {
      _status: "published",
      deletedAt: null,
    });
    expect(response.status).toBe(403);
    expect(await stored(a)).toEqual({
      _status: "draft",
      deletedAt: TRASHED,
      title: "T3 denied a",
    });
    expect(await stored(b)).toEqual({
      _status: "draft",
      deletedAt: TRASHED,
      title: "T3 denied b",
    });
  });

  test("trash-only is refused before any document is read over Local updateMany", async () => {
    const id = await seedPage("TN", "T3 denied local");
    await rejectsWith(
      updateManyAs({
        role: "trashOnly",
        ids: [id],
        data: { _status: "published", deletedAt: null },
        trash: true,
      }),
      "Forbidden",
    );
    expect(await stored(id)).toEqual({
      _status: "draft",
      deletedAt: TRASHED,
      title: "T3 denied local",
    });
  });

  test("trash, update and publish restore trashed pages as published over bulk REST", async () => {
    const a = await seedPage("TN", "T3 allowed a");
    const b = await seedPage("TN", "T3 allowed b");
    const response = await actors.trashUpdatePublish.api(
      "PATCH",
      `/pages?trash=true&${idIn(a, b)}`,
      { _status: "published", deletedAt: null },
    );
    expect(response.status).toBe(200);
    expect(failedIds(response)).toEqual(NONE);
    expect(await stored(a)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "T3 allowed a",
    });
    expect(await stored(b)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "T3 allowed b",
    });
  });

  test("trash, update and publish restore a trashed page as published over Local updateMany", async () => {
    const id = await seedPage("TN", "T3 allowed local");
    const result = await updateManyAs({
      role: "trashUpdatePublish",
      ids: [id],
      data: { _status: "published", deletedAt: null },
      trash: true,
    });
    expect(result.errors).toEqual([]);
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "T3 allowed local",
    });
  });
});

const PERMANENT_DELETES = [
  { path: (id: number | string) => `/pages/${id}?trash=true`, request: "deleteByID" },
  {
    path: (id: number | string) => `/pages?trash=true&where[id][equals]=${id}`,
    request: "bulk",
  },
] as const;

describe("T4: permanent delete of a trashed page needs delete", () => {
  test.each(PERMANENT_DELETES)("delete removes the row over REST $request", async ({ path }) => {
    const id = await seedPage("TP", "T4 allowed");
    expect((await actors.full.api("DELETE", path(id))).status).toBe(200);
    expect(await stored(id)).toBeNull();
  });

  test("delete removes the row over Local delete with trash", async () => {
    const id = await seedPage("TP", "T4 allowed local");
    await as(context.payload, actors.full.user).delete({ collection: "pages", id, trash: true });
    expect(await stored(id)).toBeNull();
  });

  const denials = (["trashOnly", "deleteMissing"] as const).flatMap((role) =>
    PERMANENT_DELETES.map(({ path, request }) => ({ path, request, role })),
  );

  test.each(denials)("$role is denied over REST $request", async ({ path, role }) => {
    const id = await seedPage("TP", `T4 ${role}`);
    expect((await actors[role].api("DELETE", path(id))).status).toBe(403);
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: TRASHED,
      title: `T4 ${role}`,
    });
  });

  test.each(["trashOnly", "deleteMissing"] as const)(
    "%s is denied over Local delete with trash",
    async (role) => {
      const id = await seedPage("TP", `T4 local ${role}`);
      await rejectsWith(
        as(context.payload, actors[role].user).delete({ collection: "pages", id, trash: true }),
        "Forbidden",
      );
      expect(await stored(id)).toEqual({
        _status: "published",
        deletedAt: TRASHED,
        title: `T4 local ${role}`,
      });
    },
  );
});

describe("T5: permanent delete of an untrashed draft needs delete", () => {
  test("delete removes N over REST and Local", async () => {
    const overRest = await seedPage("N", "T5 rest");
    expect((await actors.full.api("DELETE", `/pages/${overRest}`)).status).toBe(200);
    expect(await stored(overRest)).toBeNull();

    const overLocal = await seedPage("N", "T5 local");
    await as(context.payload, actors.full.user).delete({ collection: "pages", id: overLocal });
    expect(await stored(overLocal)).toBeNull();
  });

  test.each(["trashOnly", "deleteMissing"] as const)(
    "%s cannot permanently delete N",
    async (role) => {
      const id = await seedPage("N", `T5 ${role}`);
      expect((await actors[role].api("DELETE", `/pages/${id}`)).status).toBe(403);
      await rejectsWith(
        as(context.payload, actors[role].user).delete({ collection: "pages", id }),
        "Forbidden",
      );
      expect(await stored(id)).toEqual({ _status: "draft", deletedAt: null, title: `T5 ${role}` });
    },
  );
});

describe("bulk unpublish with mixed permission", () => {
  test("unpublish-only commits P docs and reports N docs as failed (SQLite partial commit)", async () => {
    const p1 = await seedPage("P", "Bulk P1");
    const n1 = await seedPage("N", "Bulk N1");
    const p2 = await seedPage("P", "Bulk P2");
    const response = await actors.unpublishOnly.api("PATCH", `/pages?${idIn(p1, n1, p2)}`, {
      _status: "draft",
    });
    expect(response.status).toBe(400);
    expect(failedIds(response)).toEqual(new Set([n1]));
    expect(await stored(p1)).toEqual({ _status: "draft", deletedAt: null, title: "Bulk P1" });
    expect(await stored(p2)).toEqual({ _status: "draft", deletedAt: null, title: "Bulk P2" });
    expect(await stored(n1)).toEqual({ _status: "draft", deletedAt: null, title: "Bulk N1" });
  });
});

describe("U8: bulk non-draft title edit of PD fills from the main row and needs publish", () => {
  test("update and publish keep PD published with the new title over bulk REST", async () => {
    const id = await seedPage("PD", "U8 rest");
    const response = await actors.updatePublish.api("PATCH", `/pages?${idIn(id)}`, {
      title: "U8 rest edited",
    });
    expect(response.status).toBe(200);
    expect(failedIds(response)).toEqual(NONE);
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "U8 rest edited",
    });
  });

  test("update and publish keep PD published with the new title over Local updateMany", async () => {
    const id = await seedPage("PD", "U8 local");
    const result = await updateManyAs({
      role: "updatePublish",
      ids: [id],
      data: { title: "U8 local edited" },
      trash: false,
    });
    expect(result.errors).toEqual([]);
    expect(await stored(id)).toEqual({
      _status: "published",
      deletedAt: null,
      title: "U8 local edited",
    });
  });

  test("update-only is denied per doc and PD's main row is unchanged", async () => {
    const id = await seedPage("PD", "U8 denied");
    const response = await actors.updateOnly.api("PATCH", `/pages?${idIn(id)}`, {
      title: "U8 denied edited",
    });
    expect(response.status).toBe(400);
    expect(failedIds(response)).toEqual(new Set([id]));
    expect(await stored(id)).toEqual({ _status: "published", deletedAt: null, title: "U8 denied" });
  });
});
