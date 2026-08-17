import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, handleEndpoints, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { createJpegFixture } from "./image-fixtures.ts";
import { readCreatedBlurHash } from "./rest-response.ts";

describe("temporary-file uploads", () => {
  let authToken: string;
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-temporary-file-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedTypesFile: path.join(testDirectory, "payload-types.generated.ts"),
      mediaBeforeChangeHooks: [],
      mode: "enabled-temporary-file",
      storage: false,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    payload = await getPayload({ config });
    await payload.create({
      collection: "users",
      data: { email: "temporary-file@example.com", password: "temporary-file-password" },
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

  test("a multipart upload hashes its effective temporary-file bytes", async () => {
    const jpeg = await createJpegFixture({ b: 30, g: 80, r: 160 });
    const body = new FormData();
    body.set("_payload", JSON.stringify({}));
    body.set("file", new File([jpeg], "temporary-file.jpg", { type: "image/jpeg" }));

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
      blurHash: "L9IV6m^4fQ^4}XoKfQoKfQfQfQfQ",
      status: 201,
    });
  });
});
