import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getPayload, handleEndpoints, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import {
  createS3TestClient,
  createS3TestStorage,
  deleteS3TestPrefix,
  s3TestBucket,
} from "../s3-test-context.ts";
import { createJpegFixture } from "./image-fixtures.ts";
import { readCreatedBlurHash } from "./rest-response.ts";

describe("official upload paths", () => {
  let authToken: string;
  let payload: Payload;
  let s3Prefix: string;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-upload-paths-"));
    s3Prefix = `tests/${path.basename(testDirectory)}/in-memory`;
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedTypesFile: path.join(testDirectory, "payload-types.generated.ts"),
      mediaBeforeChangeHooks: [],
      mode: "enabled-in-memory",
      storage: createS3TestStorage(s3Prefix),
      uploadDirectory: path.join(testDirectory, "media"),
    });
    payload = await getPayload({ config });
    await payload.create({
      collection: "users",
      data: { email: "upload-paths@example.com", password: "upload-paths-password" },
    });
    const login = await payload.login({
      collection: "users",
      data: { email: "upload-paths@example.com", password: "upload-paths-password" },
    });

    if (!login.token) {
      throw new Error("Expected the upload-paths fixture user to receive a token.");
    }

    authToken = login.token;
  });

  afterAll(async () => {
    await payload.destroy();
    await deleteS3TestPrefix(s3Prefix);
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("an S3 server upload stores the same document and object", async () => {
    const jpeg = await createJpegFixture({ b: 120, g: 60, r: 20 });
    const media = await payload.create({
      collection: "media",
      data: {},
      file: {
        data: jpeg,
        mimetype: "image/jpeg",
        name: "s3-server-upload.jpg",
        size: jpeg.length,
      },
    });
    const client = createS3TestClient();
    const object = await client.send(
      new GetObjectCommand({
        Bucket: s3TestBucket,
        Key: `${s3Prefix}/${media.filename}`,
      }),
    );
    const objectBytes = object.Body
      ? Buffer.from(await object.Body.transformToByteArray())
      : undefined;
    client.destroy();

    expect({
      documentHash: media.blurHash,
      objectBytes,
      status: object.$metadata.httpStatusCode,
    }).toEqual({
      documentHash: "L42QgRp2fQp2pMflfQflfQfQfQfQ",
      objectBytes: jpeg,
      status: 200,
    });
  });

  test("an in-memory multipart upload hashes its effective bytes", async () => {
    const jpeg = await createJpegFixture({ b: 180, g: 120, r: 40 });
    const body = new FormData();
    body.set("_payload", JSON.stringify({}));
    body.set("file", new File([jpeg], "in-memory.jpg", { type: "image/jpeg" }));

    const response = await handleEndpoints({
      config: payload.config,
      request: new Request("http://localhost/api/media", {
        body,
        headers: { authorization: `JWT ${authToken}` },
        method: "POST",
      }),
    });
    const { blurHash, status } = await readCreatedBlurHash(response);

    expect({ blurHash, status }).toEqual({
      blurHash: "LB4r0@pLfQpLpfflfQflfQfQfQfQ",
      status: 201,
    });
  });

  test("an official client-upload reconstruction hashes the stored S3 bytes", async () => {
    const jpeg = await createJpegFixture({ b: 90, g: 150, r: 210 });
    const filename = "client-upload.jpg";
    const client = createS3TestClient();
    await client.send(
      new PutObjectCommand({
        Body: jpeg,
        Bucket: s3TestBucket,
        ContentType: "image/jpeg",
        Key: `${s3Prefix}/${filename}`,
      }),
    );
    client.destroy();

    const body = new FormData();
    body.set("_payload", JSON.stringify({}));
    body.set(
      "file",
      JSON.stringify({
        clientUploadContext: { prefix: "" },
        collectionSlug: "media",
        filename,
        mimeType: "image/jpeg",
        size: jpeg.length,
      }),
    );
    const response = await handleEndpoints({
      config: payload.config,
      request: new Request("http://localhost/api/media", {
        body,
        headers: { authorization: `JWT ${authToken}` },
        method: "POST",
      }),
    });
    const { blurHash, status } = await readCreatedBlurHash(response);

    expect({ blurHash, status }).toEqual({
      blurHash: "LHOBSx^OfQ^O}?oefQoefQfQfQfQ",
      status: 201,
    });
  });
});
