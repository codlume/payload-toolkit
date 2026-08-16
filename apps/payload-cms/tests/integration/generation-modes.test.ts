import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isBlurhashValid } from "blurhash";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { createJpegFixture } from "./image-fixtures.ts";

const startPayload = async (blurHashEnabled: boolean, testDirectory: string, key: string) => {
  const config = await createAppConfig({
    blurHash: {
      alphaBackground: { b: 255, g: 255, r: 255 },
      enabled: blurHashEnabled,
    },
    databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
    mediaBeforeChangeHooks: [],
    uploadDirectory: path.join(testDirectory, "media"),
  });

  return getPayload({ config, key });
};

const uploadJpeg = async (payload: Payload, name: string, red: number) => {
  const jpeg = await createJpegFixture({ b: 60, g: 100, r: red });

  return payload.create({
    collection: "media",
    data: {},
    file: {
      data: jpeg,
      mimetype: "image/jpeg",
      name,
      size: jpeg.length,
    },
  });
};

describe("generation modes", () => {
  let payload: Payload | undefined;
  let results: {
    afterReenabledUpload: ReturnType<typeof isBlurhashValid>;
    beforeReenabledUpload: null | string | undefined;
    disabledCreate: null | string | undefined;
    metadataUpdate: null | string | undefined;
    preservedHash: null | string | undefined;
    removalUpdate: null | string | undefined;
    replacementUpdate: null | string | undefined;
  };
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-modes-"));
    payload = await startPayload(true, testDirectory, `${testDirectory}-enabled`);
    const metadataDocument = await uploadJpeg(payload, "metadata.jpg", 20);
    const replacementDocument = await uploadJpeg(payload, "replacement.jpg", 80);
    const removalDocument = await uploadJpeg(payload, "removal.jpg", 140);
    const preservedHash = metadataDocument.blurHash;

    await payload.destroy();
    payload = undefined;
    payload = await startPayload(false, testDirectory, `${testDirectory}-disabled`);

    const metadataUpdate = await payload.update({
      collection: "media",
      data: { blurHash: "caller-supplied" },
      id: metadataDocument.id,
    });
    const replacement = await createJpegFixture({ b: 10, g: 30, r: 200 });
    const replacementUpdate = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: replacement,
        mimetype: "image/jpeg",
        name: "disabled-replacement.jpg",
        size: replacement.length,
      },
      id: replacementDocument.id,
    });
    const removalUpdate = await payload.update({
      collection: "media",
      data: { filename: null, mimeType: null },
      id: removalDocument.id,
    });
    const disabledCreate = await uploadJpeg(payload, "disabled-create.jpg", 240);

    await payload.destroy();
    payload = undefined;
    payload = await startPayload(true, testDirectory, `${testDirectory}-reenabled`);

    const beforeReenabledUpload = await payload.findByID({
      collection: "media",
      id: disabledCreate.id,
    });
    const reenabledReplacement = await createJpegFixture({ b: 20, g: 70, r: 190 });
    const afterReenabledUpload = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: reenabledReplacement,
        mimetype: "image/jpeg",
        name: "created-reenabled.jpg",
        size: reenabledReplacement.length,
      },
      id: disabledCreate.id,
    });

    results = {
      afterReenabledUpload: isBlurhashValid(afterReenabledUpload.blurHash ?? ""),
      beforeReenabledUpload: beforeReenabledUpload.blurHash,
      disabledCreate: disabledCreate.blurHash,
      metadataUpdate: metadataUpdate.blurHash,
      preservedHash,
      removalUpdate: removalUpdate.blurHash,
      replacementUpdate: replacementUpdate.blurHash,
    };
  });

  afterAll(async () => {
    await payload?.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("disabled mode preserves the BlurHash on metadata-only updates", () => {
    expect(results.metadataUpdate).toBe(results.preservedHash);
  });

  test("disabled mode stores null for a new upload", () => {
    expect(results.disabledCreate).toBeNull();
  });

  test("disabled mode stores null for a replacement upload", () => {
    expect(results.replacementUpdate).toBeNull();
  });

  test("disabled mode stores null after file removal", () => {
    expect(results.removalUpdate).toBeNull();
  });

  test("re-enabling does not backfill an existing document", () => {
    expect(results.beforeReenabledUpload).toBeNull();
  });

  test("re-enabling generates after a future upload", () => {
    expect(results.afterReenabledUpload).toEqual({ result: true });
  });
});
