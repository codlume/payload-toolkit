import { sqliteAdapter } from "@payloadcms/db-sqlite";
import type { Config } from "payload";
import { expect, test, vi } from "vitest";

import type { AdminModule } from "../../../src/contract.ts";
import { rolesPlugin } from "../../../src/plugin.ts";

vi.mock("../../../src/admin/index.ts", () => {
  const admin: AdminModule = {
    permissionsField: undefined,
    collectionEdit: () => ({
      UnpublishButton: "plugin#Unpublish",
      beforeDocumentControls: ["plugin#Control"],
    }),
    globalElements: () => ({ beforeDocumentControls: ["plugin#GlobalControl"] }),
  };
  return { admin };
});

const sourceConfig = (): Config => ({
  admin: { user: "users" },
  collections: [
    { auth: true, fields: [], slug: "users" },
    {
      admin: {
        components: {
          edit: { PublishButton: "app#Publish", beforeDocumentControls: ["app#Control"] },
        },
      },
      fields: [{ name: "title", type: "text" }],
      slug: "pages",
      versions: { drafts: true },
    },
  ],
  db: sqliteAdapter({ client: { url: ":memory:" } }),
  globals: [
    {
      admin: { components: { elements: { beforeDocumentControls: ["app#GlobalControl"] } } },
      fields: [{ name: "title", type: "text" }],
      slug: "settings",
      versions: { drafts: true },
    },
  ],
  secret: "admin-slots-test-secret",
});

test("admin document controls render after the app's own instead of replacing them", async () => {
  const config = await rolesPlugin({ collections: ["pages"], globals: ["settings"] })(
    sourceConfig(),
  );

  const pages = config.collections?.find(({ slug }) => slug === "pages");
  expect(pages?.admin?.components?.edit).toEqual({
    PublishButton: "app#Publish",
    UnpublishButton: "plugin#Unpublish",
    beforeDocumentControls: ["app#Control", "plugin#Control"],
  });

  const settings = config.globals?.find(({ slug }) => slug === "settings");
  expect(settings?.admin?.components?.elements?.beforeDocumentControls).toEqual([
    "app#GlobalControl",
    "plugin#GlobalControl",
  ]);
});

test("an app's own edit component keeps its slot, and the plugin's controls still follow the app's", async () => {
  const source = sourceConfig();
  const pages = source.collections?.find(({ slug }) => slug === "pages");
  Object.assign(pages?.admin?.components?.edit ?? {}, { UnpublishButton: "app#Unpublish" });
  const config = await rolesPlugin({ collections: ["pages"] })(source);

  expect(config.collections?.find(({ slug }) => slug === "pages")?.admin?.components?.edit).toEqual(
    {
      PublishButton: "app#Publish",
      UnpublishButton: "app#Unpublish",
      beforeDocumentControls: ["app#Control", "plugin#Control"],
    },
  );
});

test("disabled mode leaves the app's admin components as the app wrote them", async () => {
  const config = await rolesPlugin({
    collections: ["pages"],
    enabled: false,
    globals: ["settings"],
  })(sourceConfig());

  const source = sourceConfig();
  const find = (slug: string) => config.collections?.find((collection) => collection.slug === slug);
  expect(find("pages")?.admin).toEqual(
    source.collections?.find(({ slug }) => slug === "pages")?.admin,
  );
  expect(config.globals?.find(({ slug }) => slug === "settings")?.admin).toEqual(
    source.globals?.find(({ slug }) => slug === "settings")?.admin,
  );
});
