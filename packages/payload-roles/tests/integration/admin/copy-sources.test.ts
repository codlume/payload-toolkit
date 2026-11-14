import { createLocalReq, type Plugin } from "payload";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import { PermissionsField } from "@codlume/payload-roles";

import { type Actor, fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

vi.mock("@codlume/payload-roles/client", () => ({ PermissionsMatrix: () => null }));

const BLIND = "blind@example.com";

/** An app's field access that hides every role's permissions from one user. */
const hidePermissionsFromBlind: Plugin = (config) => ({
  ...config,
  collections: (config.collections ?? []).map((collection) =>
    collection.slug === "roles"
      ? {
          ...collection,
          fields: collection.fields.map((field) =>
            "name" in field && field.name === "permissions"
              ? { ...field, access: { read: ({ req }) => req.user?.email !== BLIND } }
              : field,
          ),
        }
      : collection,
  ),
});
// The roles collection exists only once the roles plugin, ordered last, has run.
hidePermissionsFromBlind.order = Number.MAX_SAFE_INTEGER;

let context: TestPayload;
let target: number | string;
let users: Record<"blind" | "sighted", Actor>;

beforeAll(async () => {
  context = await createTestPayload({
    name: "admin-copy-sources",
    plugins: [hidePermissionsFromBlind],
  });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  const reader = await seedRole(payload, "reader", {
    collections: { pages: { actions: ["read"] }, roles: { actions: ["read", "update"] } },
  });
  target = await seedRole(payload, "target", {});
  users = {
    blind: await seedUser(payload, { email: BLIND, roles: [reader] }),
    sighted: await seedUser(payload, { email: "sighted@example.com", roles: [reader] }),
  };
});

afterAll(async () => {
  await context.destroy();
});

const copySourcesFor = async (actor: Actor) => {
  const req = await createLocalReq(
    { user: await fresh(context.payload, actor.id) },
    context.payload,
  );
  const element = await PermissionsField({
    clientField: { name: "permissions", type: "json" },
    id: target,
    path: "permissions",
    readOnly: false,
    req,
    value: {},
  });
  const props: unknown = element.props;
  if (typeof props !== "object" || props === null || !("model" in props)) {
    throw new Error("PermissionsField rendered no model");
  }
  const { model } = props;
  if (typeof model !== "object" || model === null || !("copySources" in model)) {
    throw new Error("the model has no copy sources");
  }
  return model.copySources;
};

test("a role whose permissions field the editor cannot read is never a copy source", async () => {
  expect(await copySourcesFor(users.sighted)).toEqual([
    expect.objectContaining({ name: "reader" }),
  ]);
  expect(await copySourcesFor(users.blind)).toEqual([]);
});
