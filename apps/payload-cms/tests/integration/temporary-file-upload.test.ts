import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode, isBlurhashValid } from "blurhash";
import { getPayload, handleEndpoints, type Payload } from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { readImageFixture } from "./image-fixtures.ts";
import { readCreatedMedia, readStoredMedia } from "./rest-response.ts";

describe("temporary-file uploads", () => {
  let authToken: string;
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-temporary-file-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedFiles: {
        importMap: path.join(testDirectory, "importMap.js"),
        types: path.join(testDirectory, "payload-types.generated.ts"),
      },
      mediaBeforeChangeHooks: [],
      mode: "enabled-temporary-file",
      storage: false,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    const mediaCollection = config.collections.find((collection) => collection.slug === "media");

    if (!mediaCollection?.upload) {
      throw new Error("Expected the media fixture collection to be upload-enabled.");
    }

    mediaCollection.upload.formatOptions = { format: "png" };
    mediaCollection.upload.resizeOptions = { fit: "fill", height: 4, width: 4 };
    payload = await getPayload({ config });
    await payload.create({
      collection: "users",
      data: {
        email: "temporary-file@example.com",
        name: "Temporary File Admin",
        password: "temporary-file-password",
      },
    });
    const login = await payload.login({
      collection: "users",
      data: { email: "temporary-file@example.com", password: "temporary-file-password" },
    });

    if (!login.token) {
      throw new Error("Expected the temporary-file fixture user to receive a token.");
    }

    authToken = login.token;
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("a multipart upload hashes Payload's resized and reformatted temporary-file bytes", async () => {
    const upload = async (data: Buffer, name: string, type: string) => {
      const body = new FormData();
      body.set("_payload", JSON.stringify({}));
      body.set("file", new File([new Uint8Array(data)], name, { type }));

      const response = await handleEndpoints({
        config: payload.config,
        request: new Request("http://localhost/api/media", {
          body,
          headers: { authorization: `JWT ${authToken}` },
          method: "POST",
        }),
      });

      return readCreatedMedia(response);
    };
    const source = await readImageFixture("jpeg-baseline.jpg");
    const transformedUpload = await upload(source, "temporary-file.jpg", "image/jpeg");
    const stored = await readStoredMedia(payload.config, transformedUpload.filename);
    const storedMetadata = await sharp(stored).metadata();
    const repeatedUpload = await upload(stored, "stored.png", "image/png");

    expect({
      decodedBytes: decode(transformedUpload.blurHash, 4, 3).length,
      dimensions: `${storedMetadata.width}x${storedMetadata.height}`,
      hashMatchesStoredPixels: transformedUpload.blurHash === repeatedUpload.blurHash,
      mimeType: transformedUpload.mimeType,
      sourceWasTransformed: !stored.equals(source),
      statuses: [transformedUpload.status, repeatedUpload.status],
      validation: isBlurhashValid(transformedUpload.blurHash),
    }).toEqual({
      decodedBytes: 48,
      dimensions: "4x4",
      hashMatchesStoredPixels: true,
      mimeType: "image/png",
      sourceWasTransformed: true,
      statuses: [201, 201],
      validation: { result: true },
    });
  });
});
