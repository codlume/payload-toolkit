import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, getPayload } from "payload";
import { afterEach, expect, test, vi } from "vitest";

import { activityPlugin } from "@codlume/payload-activity";

afterEach(() => vi.unstubAllEnvs());

test.each([
  ["admins", false, undefined],
  ["customers", true, undefined],
  ["customers", true, "users"],
] as const)(
  "attributes writes using Payload's admin collection (%s, users=%s, explicit=%s)",
  async (firstAuthCollection, includeUsers, explicitAdmin) => {
    vi.stubEnv("PAYLOAD_FORCE_DRIZZLE_PUSH", "true");
    const directory = await mkdtemp(path.join(tmpdir(), "activity-admin-default-"));
    const config = await buildConfig({
      ...(explicitAdmin && { admin: { user: explicitAdmin } }),
      collections: [
        { fields: [{ name: "title", type: "text" }], slug: "posts" },
        { auth: true, fields: [], slug: firstAuthCollection },
        ...(includeUsers ? [{ auth: true, fields: [], slug: "users" }] : []),
      ],
      db: sqliteAdapter({ client: { url: `file:${path.join(directory, "payload.db")}` } }),
      plugins: [activityPlugin({ collections: ["posts"] })],
      secret: "activity-admin-default-test",
    });
    const payload = await getPayload({ config, key: `${firstAuthCollection}-${explicitAdmin}` });
    try {
      const adminCollection = explicitAdmin ?? firstAuthCollection;
      const admin = await payload.create({
        collection: adminCollection,
        data: { email: "admin@example.com", password: "test-password" },
      });
      const post = await payload.create({
        collection: "posts",
        data: { title: "Admin-authored post" },
        depth: 0,
        overrideAccess: false,
        user: admin,
      });

      expect(payload.config.admin.user).toBe(adminCollection);
      expect(post.lastModifiedBy).toBe(admin.id);
      expect(await payload.findByID({ collection: "posts", depth: 1, id: post.id })).toMatchObject({
        lastModifiedBy: { email: "admin@example.com", id: admin.id },
      });
    } finally {
      await payload.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  },
);
