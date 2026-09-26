import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, getPayload } from "payload";
import { expect, test } from "vitest";

import { activityPlugin } from "@codlume/payload-activity";

test("disabled attribution clears duplicates and preserves updates", async () => {
  const config = await buildConfig({
    collections: [
      { auth: true, fields: [], slug: "users" },
      { fields: [{ name: "title", type: "text" }], slug: "posts" },
    ],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins: [activityPlugin({ collections: ["posts"], enabled: false })],
    secret: "activity-disabled-duplicate-test",
  });
  const payload = await getPayload({ config });
  try {
    const admin = await payload.create({
      collection: "users",
      data: { email: "admin@example.com", password: "test-password" },
    });
    const source = await payload.create({
      collection: "posts",
      data: { title: "Original" },
      depth: 0,
      user: admin,
    });
    expect(source.lastModifiedBy).toBeNull();

    await payload.db.updateOne({
      collection: "posts",
      data: { lastModifiedBy: admin.id },
      id: source.id,
    });
    const updated = await payload.update({
      collection: "posts",
      data: { title: "Original updated while disabled" },
      depth: 0,
      id: source.id,
    });
    expect(updated.lastModifiedBy).toBe(admin.id);

    const duplicate = await payload.duplicate({
      collection: "posts",
      data: { title: "Duplicate" },
      depth: 0,
      id: source.id,
      user: admin,
    });
    expect(duplicate.id).not.toBe(source.id);
    expect(duplicate.lastModifiedBy).toBeNull();
    expect(
      await payload.findByID({ collection: "posts", depth: 0, id: duplicate.id }),
    ).toMatchObject({ lastModifiedBy: null, title: "Duplicate" });
    expect(await payload.findByID({ collection: "posts", depth: 0, id: source.id })).toMatchObject({
      lastModifiedBy: admin.id,
      title: "Original updated while disabled",
    });
  } finally {
    await payload.destroy();
  }
});
