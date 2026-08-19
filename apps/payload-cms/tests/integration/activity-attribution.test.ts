import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { createJpegFixture } from "./image-fixtures.ts";

describe("activity attribution", () => {
  let adminUserID: number | string;
  let attributedValue: unknown;
  let autosaveValue: unknown;
  let clearedValue: unknown;
  let draftValue: unknown;
  let draftsEnabled: boolean;
  let globalAttributedValue: unknown;
  let globalClearedValue: unknown;
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-activity-attribution-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedFiles: {
        importMap: path.join(testDirectory, "importMap.js"),
        types: path.join(testDirectory, "payload-types.generated.ts"),
      },
      mediaBeforeChangeHooks: [],
      mode: "enabled-in-memory",
      storage: false,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    payload = await getPayload({ config });
    const mediaConfig = payload.config.collections.find(({ slug }) => slug === "media");
    draftsEnabled = Boolean(
      mediaConfig?.versions &&
      typeof mediaConfig.versions === "object" &&
      mediaConfig.versions.drafts,
    );

    const admin = await payload.create({
      collection: "users",
      data: { email: "activity@example.com", password: "activity-password" },
    });
    adminUserID = admin.id;

    const attributedGlobal = await payload.updateGlobal({
      data: {},
      depth: 0,
      overrideAccess: false,
      slug: "site-settings",
      user: admin,
    });
    globalAttributedValue = Reflect.get(attributedGlobal, "lastModifiedBy");

    const clearedGlobal = await payload.updateGlobal({
      data: {},
      depth: 0,
      slug: "site-settings",
    });
    globalClearedValue = Reflect.get(clearedGlobal, "lastModifiedBy");

    const input = await createJpegFixture({ b: 30, g: 90, r: 180 });
    const attributed = await payload.create({
      collection: "media",
      data: {},
      depth: 0,
      file: {
        data: input,
        mimetype: "image/jpeg",
        name: "attributed.jpg",
        size: input.length,
      },
      overrideAccess: false,
      user: admin,
    });
    attributedValue = Reflect.get(attributed, "lastModifiedBy");

    const cleared = await payload.update({
      collection: "media",
      data: {},
      depth: 0,
      id: attributed.id,
    });
    clearedValue = Reflect.get(cleared, "lastModifiedBy");

    const draft = await payload.update({
      collection: "media",
      data: {},
      depth: 0,
      draft: true,
      id: attributed.id,
      overrideAccess: false,
      user: admin,
    });
    draftValue = Reflect.get(draft, "lastModifiedBy");

    const autosave = await payload.update({
      autosave: true,
      collection: "media",
      data: {},
      depth: 0,
      draft: true,
      id: attributed.id,
      overrideAccess: false,
      user: admin,
    });
    autosaveValue = Reflect.get(autosave, "lastModifiedBy");
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("an authenticated admin write records that user", () => {
    expect(attributedValue).toBe(adminUserID);
  });

  test("an unattributed Local API write clears the user", () => {
    expect(clearedValue).toBeNull();
  });

  test("an authenticated draft save records that user", () => {
    expect({ draftsEnabled, value: draftValue }).toEqual({
      draftsEnabled: true,
      value: adminUserID,
    });
  });

  test("an authenticated autosave records that user", () => {
    expect(autosaveValue).toBe(adminUserID);
  });

  test("an authenticated global update records that user", () => {
    expect(globalAttributedValue).toBe(adminUserID);
  });

  test("an unattributed Local API global update clears the user", () => {
    expect(globalClearedValue).toBeNull();
  });
});
