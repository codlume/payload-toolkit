// Two Payload instances in one process, each with its own roles plugin. One user object
// resolved by both gets each instance's own answer, never the other's remembered one.
import { createLocalReq } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { resolveCapabilities } from "@codlume/payload-roles";

import { type Actor, fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

let pages: TestPayload;
let posts: TestPayload;
let reader: Actor;

/** The same rows in each instance, so one user object names the same user in both. */
const seed = async ({ payload }: TestPayload) => {
  await seedUser(payload, { email: "super@example.com" });
  const role = await seedRole(payload, "reader", {
    collections: { pages: { actions: ["read"] }, posts: { actions: ["read"] } },
  });
  return seedUser(payload, { email: "reader@example.com", roles: [role] });
};

beforeAll(async () => {
  pages = await createTestPayload({
    name: "two-instances-pages",
    roles: { collections: ["users", "pages"], debug: true },
  });
  posts = await createTestPayload({
    name: "two-instances-posts",
    roles: { collections: ["users", "posts"], debug: true },
  });
  const user = await seed(pages);
  expect((await seed(posts)).id).toBe(user.id);
  reader = await fresh(pages.payload, user.id);
});

afterAll(async () => {
  await pages.destroy();
  await posts.destroy();
});

const grantsOf = async ({ payload }: TestPayload, user: Actor) => {
  const capabilities = await resolveCapabilities(await createLocalReq({ user }, payload));
  return capabilities?.kind === "grants" ? [...capabilities.grants] : capabilities;
};

test("one user object resolves against each instance's own managed resources", async () => {
  expect(await grantsOf(pages, reader)).toEqual(["collections:pages#read"]);
  expect(await grantsOf(posts, reader)).toEqual(["collections:posts#read"]);
  expect(await grantsOf(pages, reader)).toEqual(["collections:pages#read"]);
});
