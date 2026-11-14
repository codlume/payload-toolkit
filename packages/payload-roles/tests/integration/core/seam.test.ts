// The lifecycle seam, driven through the real plugin with a stand-in lifecycle module: a store
// opened in `leadingBeforeOperation` must reach the operation's `beforeChange` on every managed
// collection and global, even when an app `beforeOperation` hook awaits first.
import { AsyncLocalStorage } from "node:async_hooks";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import {
  buildConfig,
  type CollectionConfig,
  getPayload,
  type GlobalConfig,
  type Plugin,
} from "payload";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import type { LifecycleModule, Resource } from "../../../src/contract.ts";
import { rolesPlugin } from "../../../src/plugin.ts";
import { PASSWORD } from "../../helpers/actors.ts";
import { defaultRolesOptions, fixtureCollections, fixtureGlobals } from "../../helpers/payload.ts";

const seen = vi.hoisted(() => ({ stores: new Map<string, (null | string)[]>() }));

vi.mock("../../../src/lifecycle/index.ts", async (importOriginal) => {
  const original: { lifecycle: LifecycleModule } = await importOriginal();
  const store = new AsyncLocalStorage<string>();
  const hooksFor = (resource: Resource) => ({
    leadingBeforeOperation: (): undefined => {
      store.enterWith(resource.slug);
    },
    beforeChange: [
      ({ data }: { data: Record<string, unknown> }) => {
        const list = seen.stores.get(resource.slug) ?? [];
        list.push(store.getStore() ?? null);
        seen.stores.set(resource.slug, list);
        return data;
      },
    ],
  });
  const lifecycle: LifecycleModule = {
    ...original.lifecycle,
    collectionHooks: hooksFor,
    globalHooks: hooksFor,
  };
  return { lifecycle };
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

const awaiting = async () => {
  await tick();
};

const withAwaitingApp = <T extends CollectionConfig | GlobalConfig>(config: T): T => ({
  ...config,
  hooks: { ...config.hooks, beforeOperation: [awaiting] },
});

/** The plugin creates the roles collection, so a later plugin stands in for its app hook. */
const awaitOnRoles: Plugin = (incoming) => {
  const roles = incoming.collections?.find((collection) => collection.slug === "roles");
  if (roles) {
    roles.hooks = {
      ...roles.hooks,
      beforeOperation: [...(roles.hooks?.beforeOperation ?? []), awaiting],
    };
  }
  return incoming;
};
awaitOnRoles.order = Number.MAX_SAFE_INTEGER;

process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = "true";

const config = buildConfig({
  collections: fixtureCollections().map(withAwaitingApp),
  db: sqliteAdapter({ client: { url: ":memory:" } }),
  globals: fixtureGlobals().map(withAwaitingApp),
  plugins: [rolesPlugin(defaultRolesOptions()), awaitOnRoles],
  secret: "payload-roles-test-secret",
  telemetry: false,
});

let payload: Awaited<ReturnType<typeof getPayload>>;

beforeAll(async () => {
  payload = await getPayload({ config: await config, key: `seam-${crypto.randomUUID()}` });
});

afterAll(() => payload.destroy());

test("a store opened in leadingBeforeOperation reaches beforeChange on users, roles, a collection and a global", async () => {
  const user = await payload.create({
    collection: "users",
    data: { email: "seam@example.com", password: PASSWORD },
  });
  await payload.update({ collection: "users", data: { email: "seam2@example.com" }, id: user.id });
  const role = await payload.create({
    collection: "roles",
    data: { key: "seam", name: "seam", permissions: {} },
  });
  await payload.update({ collection: "roles", data: { name: "seam 2" }, id: role.id });
  await payload.create({ collection: "pages", data: { title: "a" } });
  await payload.updateGlobal({ data: { siteName: "a" }, slug: "settings" });

  expect(Object.fromEntries(seen.stores)).toEqual({
    pages: ["pages"],
    roles: ["roles", "roles"],
    settings: ["settings"],
    users: ["users", "users"],
  });
});
