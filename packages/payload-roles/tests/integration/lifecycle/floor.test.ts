import { createLocalReq } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { enforcerOf } from "../../../src/contract.ts";
import { lifecycle } from "../../../src/lifecycle/index.ts";
import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let context: TestPayload;
let users: Record<"nobody" | "unpublishOnly", Actor>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-floor" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const unpublishOnly = await seedRole(payload, "unpublish-only", {
    collections: { pages: { actions: ["read", "unpublish"] } },
  });
  users = {
    nobody: await seedUser(payload, { email: "nobody@example.com" }),
    unpublishOnly: await seedUser(payload, {
      email: "unpublish-only@example.com",
      roles: [unpublishOnly],
    }),
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

const stored = (id: number | string) =>
  context.payload.db.findOne({ collection: "pages", where: { id: { equals: id } } });

test("the access floor sees the plan: an unpublish-only member unpublishes by status alone", async () => {
  const id = await publishedPage("floor unpublish");

  await as(context.payload, users.unpublishOnly).update({
    collection: "pages",
    data: { _status: "draft" },
    id,
  });

  expect(await stored(id)).toMatchObject({ _status: "draft", title: "floor unpublish" });
});

test("a member who can satisfy no outcome is refused before access, so a missing id is 403, not 404", async () => {
  const id = await publishedPage("floor nobody");
  const nobody = rest(context, await login(context.payload, users.nobody.email));

  expect((await nobody("PATCH", `/pages/${id}`, { _status: "draft" })).status).toBe(403);
  expect((await nobody("PATCH", "/pages/987654321", { _status: "draft" })).status).toBe(403);

  expect(await stored(id)).toMatchObject({ _status: "published", title: "floor nobody" });
});

test("a beforeChange hook that finds no planned frame refuses the write", async () => {
  const { payload } = context;
  const enforcer = enforcerOf(payload);
  const resource = enforcer.registry.get("collections:pages");
  const collection = payload.collections.pages;
  if (!resource || !collection) {
    throw new Error("pages is a managed collection");
  }
  const check = lifecycle.collectionHooks(resource, enforcer).beforeChange?.[0];
  if (!check) {
    throw new Error("the lifecycle installs a beforeChange hook on pages");
  }
  const id = await publishedPage("no frame");
  const req = await createLocalReq({ user: users.unpublishOnly }, payload);

  await rejectsWith(
    Promise.resolve(
      check({
        collection: collection.config,
        context: req.context,
        data: { _status: "draft", title: "no frame" },
        operation: "update",
        originalDoc: { id },
        req,
      }),
    ),
    "Forbidden",
  );

  expect(context.logs).toContainEqual(
    expect.objectContaining({ event: "lifecycle_denied", reason: "intent-missing" }),
  );
});
