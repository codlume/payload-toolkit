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
