import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql, sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, createLocalReq, getPayload, type GlobalAfterChangeHook } from "payload";
import { afterEach, expect, test, vi } from "vitest";

import { activityPlugin } from "@codlume/payload-activity";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cases = [
  { actor: "admin", depth: 0, enabled: true, fieldName: "lastModifiedBy", rollback: false },
  { actor: "admin", depth: 2, enabled: true, fieldName: "editedBy", rollback: false },
  { actor: "anonymous", depth: 0, enabled: true, fieldName: "lastModifiedBy", rollback: false },
  { actor: "foreign", depth: 0, enabled: true, fieldName: "editedBy", rollback: false },
  { actor: "admin", depth: 0, enabled: false, fieldName: "lastModifiedBy", rollback: false },
  { actor: "anonymous", depth: 0, enabled: true, fieldName: "editedBy", rollback: true },
] as const;

test.each(cases)(
  "restores global attribution for $actor, depth=$depth, enabled=$enabled, field=$fieldName, rollback=$rollback",
  async ({ actor, depth, enabled, fieldName, rollback }) => {
    vi.stubEnv("PAYLOAD_FORCE_DRIZZLE_PUSH", "true");
    const directory = await mkdtemp(path.join(tmpdir(), "activity-global-restore-"));
    const afterChange = vi.fn<GlobalAfterChangeHook>(({ doc, req }) => {
      if (req.context.rejectRestore && req.context.isRestoringVersion) {
        throw new Error("Reject restored content");
      }
      return doc;
    });
    const config = await buildConfig({
      admin: { user: "users" },
      collections: [
        { auth: true, fields: [], slug: "users" },
        { auth: true, fields: [], slug: "customers" },
      ],
      db: sqliteAdapter({
        client: { url: `file:${path.join(directory, "payload.db")}` },
        transactionOptions: {},
      }),
      globals: [
        {
          fields: [
            { name: "title", type: "text" },
            { name: "version", type: "group", fields: [{ name: "label", type: "text" }] },
          ],
          hooks: { afterChange: [afterChange] },
          slug: "settings",
          versions: true,
        },
        {
          fields: [
            { name: "title", type: "text" },
            { name: "version", type: "group", fields: [{ name: "label", type: "text" }] },
          ],
          slug: "unversioned",
        },
      ],
      plugins: [activityPlugin({ enabled, fieldName, globals: ["settings", "unversioned"] })],
      secret: "activity-global-restore-test",
    });
    const payload = await getPayload({ config, key: `${actor}-${depth}-${enabled}-${rollback}` });
    try {
      const author = await payload.create({
        collection: "users",
        data: { email: "author@example.com", password: "test-password" },
      });
      const editor = await payload.create({
        collection: "users",
        data: { email: "editor@example.com", password: "test-password" },
      });
      const customer = await payload.create({
        collection: "customers",
        data: { email: "customer@example.com", password: "test-password" },
      });
      await payload.updateGlobal({ data: { title: "First" }, slug: "settings", user: author });
      const firstVersions = await payload.findGlobalVersions({ slug: "settings", depth: 0 });
      const firstVersion = firstVersions.docs[0];
      if (!firstVersion) throw new Error("Expected the first saved version");
      if (!enabled) {
        await payload.db.updateGlobalVersion({
          global: "settings",
          id: firstVersion.id,
          versionData: { version: { [fieldName]: author.id } },
        });
      }
      await payload.updateGlobal({ data: { title: "Second" }, slug: "settings", user: editor });
      if (!enabled) {
        await payload.db.updateGlobal({ slug: "settings", data: { [fieldName]: editor.id } });
      }
      const beforeRestore = await payload.findGlobal({ slug: "settings", depth: 0 });
      const versionsBefore = await payload.findGlobalVersions({ slug: "settings", depth: 0 });
      afterChange.mockClear();
      const updateGlobal = vi.spyOn(payload.db, "updateGlobal");
      const updateVersion = vi.spyOn(payload.db, "updateGlobalVersion");
      const user = actor === "admin" ? editor : actor === "foreign" ? customer : undefined;
      const req = await createLocalReq(
        {
          context: { rejectRestore: rollback },
          ...(user && {
            user: { ...user, collection: actor === "foreign" ? "customers" : "users" },
          }),
        },
        payload,
      );
      const restore = payload.restoreGlobalVersion({
        depth,
        id: firstVersion.id,
        req,
        slug: "settings",
        user,
      });

      if (rollback) {
        await expect(restore).rejects.toThrow("Reject restored content");
        expect(await payload.findGlobal({ slug: "settings", depth: 0 })).toEqual(beforeRestore);
        expect(await payload.findGlobalVersions({ slug: "settings", depth: 0 })).toEqual(
          versionsBefore,
        );
      } else {
        const restored = await restore;
        const expected = !enabled ? author.id : actor === "admin" ? editor.id : null;
        expect(restored).toMatchObject({ version: { [fieldName]: expected, title: "First" } });
        expect(await payload.findGlobal({ depth: 0, slug: "settings" })).toMatchObject({
          [fieldName]: expected,
          title: "First",
        });
        const versionsAfter = await payload.findGlobalVersions({ slug: "settings", depth: 0 });
        expect(versionsAfter.totalDocs).toBe(versionsBefore.totalDocs + 1);
        expect(versionsAfter.docs.find(({ id }) => id === restored.id)?.version).toMatchObject({
          [fieldName]: expected,
          title: "First",
        });
        for (const previousVersion of versionsBefore.docs) {
          expect(versionsAfter.docs.find(({ id }) => id === previousVersion.id)).toEqual(
            previousVersion,
          );
        }
        expect(afterChange.mock.results[0]?.value).toEqual(restored);
      }

      expect(afterChange).toHaveBeenCalledTimes(1);
      expect(updateGlobal).toHaveBeenCalledTimes(enabled ? 2 : 1);
      expect(updateVersion).toHaveBeenCalledTimes(enabled ? 1 : 0);
      if (enabled) {
        const nativeRequest = updateGlobal.mock.calls[0]?.[0].req;
        expect(nativeRequest).toBeDefined();
        expect(updateGlobal.mock.calls[1]?.[0].req).toBe(nativeRequest);
        expect(updateVersion.mock.calls[0]?.[0].req).toBe(nativeRequest);
      }

      if (!rollback) {
        updateVersion.mockClear();
        await payload.updateGlobal({
          data: { title: "Third", version: { label: "Release three" } },
          req,
          slug: "settings",
        });
        expect(updateVersion).not.toHaveBeenCalled();
        const history = await payload.findGlobalVersions({ slug: "settings", depth: 0 });
        for (const previousVersion of versionsBefore.docs) {
          expect(history.docs.find(({ id }) => id === previousVersion.id)).toEqual(previousVersion);
        }
        updateGlobal.mockClear();
        expect(
          await payload.updateGlobal({
            data: { title: "Unversioned", version: { label: "One" } },
            req,
            slug: "unversioned",
          }),
        ).toMatchObject({ title: "Unversioned", version: { label: "One" } });
        expect(updateGlobal).toHaveBeenCalledTimes(1);
        expect(updateVersion).not.toHaveBeenCalled();
      }
    } finally {
      await payload.destroy();
      await rm(directory, { force: true, recursive: true });
    }
  },
);

test("restores a missing global with its own version group without changing its snapshot", async () => {
  vi.stubEnv("PAYLOAD_FORCE_DRIZZLE_PUSH", "true");
  const config = await buildConfig({
    collections: [{ auth: true, fields: [], slug: "users" }],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    globals: [
      {
        fields: [{ name: "version", type: "group", fields: [{ name: "label", type: "text" }] }],
        slug: "settings",
        versions: true,
      },
    ],
    plugins: [activityPlugin({ globals: ["settings"] })],
    secret: "activity-missing-global-test",
  });
  const payload = await getPayload({ config, key: "missing-global" });
  try {
    const editor = await payload.create({
      collection: "users",
      data: { email: "editor@example.com", password: "test-password" },
    });
    await payload.updateGlobal({ data: { version: { label: "One" } }, slug: "settings" });
    const versions = await payload.findGlobalVersions({ depth: 0, slug: "settings" });
    const snapshot = versions.docs[0];
    if (!snapshot) throw new Error("Expected a saved version");
    await payload.db.drizzle.run(sql`DELETE FROM settings`);
    const findGlobal = payload.db.findGlobal.bind(payload.db);
    vi.spyOn(payload.db, "findGlobal").mockImplementation(async (args) => {
      const doc = await findGlobal(args);
      return Object.keys(doc).length === 0 ? null : doc;
    });

    const restored = await payload.restoreGlobalVersion({
      depth: 0,
      id: snapshot.id,
      slug: "settings",
      user: editor,
    });
    expect(restored).toMatchObject({ lastModifiedBy: editor.id, version: { label: "One" } });
    expect(await payload.findGlobal({ depth: 0, slug: "settings" })).toMatchObject({
      lastModifiedBy: editor.id,
      version: { label: "One" },
    });
    expect(await payload.findGlobalVersions({ depth: 0, slug: "settings" })).toEqual(versions);
  } finally {
    await payload.destroy();
  }
});
