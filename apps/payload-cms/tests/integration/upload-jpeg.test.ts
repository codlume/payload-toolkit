import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { GRAPHQL_POST } from "@payloadcms/next/routes";
import { isBlurhashValid } from "blurhash";
import {
  type CollectionBeforeChangeHook,
  getPayload,
  handleEndpoints,
  type Payload,
} from "payload";
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import type { Media } from "../../src/payload-types.generated.ts";
import { createJpegFixture } from "./image-fixtures.ts";
import { readStoredMedia } from "./rest-response.ts";

const CALLER_SUPPLIED_HASH = "caller-supplied";
const failBlurHashGeneration: CollectionBeforeChangeHook = ({ context, data, req }) => {
  if (context.failBlurHashGeneration && req.file) {
    req.file.data = Buffer.from("invalid image data");
  }

  return data;
};

describe("BlurHash upload lifecycle", () => {
  let blurHash: string;
  let mediaID: number | string;
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedFiles: {
        importMap: path.join(testDirectory, "importMap.js"),
        types: path.join(testDirectory, "payload-types.generated.ts"),
      },
      mediaBeforeChangeHooks: [failBlurHashGeneration],
      mode: "enabled-in-memory",
      storage: false,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    payload = await getPayload({ config });
    const jpeg = await createJpegFixture({ b: 80, g: 40, r: 200 });

    const created = await payload.create({
      collection: "media",
      data: { blurHash: CALLER_SUPPLIED_HASH },
      file: {
        data: jpeg,
        mimetype: "image/jpeg",
        name: "fixture.jpg",
        size: jpeg.length,
      },
    });

    if (typeof created.blurHash !== "string") {
      throw new TypeError("Expected the uploaded JPEG to have a BlurHash");
    }

    blurHash = created.blurHash;
    mediaID = created.id;
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("the generated collection type exposes Payload's optional nullable field contract", () => {
    expectTypeOf<Media["blurHash"]>().toEqualTypeOf<string | null | undefined>();
  });

  test("generated upload collection slugs configure the plugin", () => {
    expectTypeOf<{ collections: ["media"] }>().toMatchTypeOf<BlurHashPluginOptions>();
  });

  test("generated non-upload collection slugs do not configure the plugin", () => {
    expectTypeOf<{ collections: ["users"] }>().not.toMatchTypeOf<BlurHashPluginOptions>();
  });

  test("an in-memory JPEG receives a readable BlurHash through the Local API", async () => {
    const media = await payload.findByID({
      collection: "media",
      id: mediaID,
    });

    if (typeof media.filename !== "string" || typeof media.mimeType !== "string") {
      throw new TypeError("Expected stored media metadata.");
    }

    const stored = await readStoredMedia(payload.config, media.filename);
    const repeated = await payload.create({
      collection: "media",
      data: {},
      file: {
        data: stored,
        mimetype: media.mimeType,
        name: `stored-${media.filename}`,
        size: stored.length,
      },
    });

    expect({
      hash: media.blurHash,
      hashMatchesStoredBytes: media.blurHash === repeated.blurHash,
      length: media.blurHash?.length,
      validation: isBlurhashValid(media.blurHash ?? ""),
    }).toEqual({
      hash: blurHash,
      hashMatchesStoredBytes: true,
      length: 28,
      validation: { result: true },
    });
  });

  test("a caller-supplied value cannot replace generation on create", () => {
    expect(blurHash).not.toBe(CALLER_SUPPLIED_HASH);
  });

  test("a metadata-only Local API update cannot replace the generated BlurHash", async () => {
    await payload.update({
      collection: "media",
      data: { blurHash: "caller-supplied" },
      id: mediaID,
    });

    const media = await payload.findByID({ collection: "media", id: mediaID });

    expect(media.blurHash).toBe(blurHash);
  });

  test("non-persisted file metadata cannot clear the generated BlurHash", async () => {
    const callerData = { blurHash: CALLER_SUPPLIED_HASH, file: null };
    await payload.update({ collection: "media", data: callerData, id: mediaID });

    const media = await payload.findByID({ collection: "media", id: mediaID });

    expect(media.blurHash).toBe(blurHash);
  });

  test("the generated field is readable through the REST API", async () => {
    const response = await handleEndpoints({
      config: payload.config,
      request: new Request(`http://localhost/api/media/${mediaID}`),
    });

    expect({ body: await response.json(), status: response.status }).toMatchObject({
      body: { blurHash },
      status: 200,
    });
  });

  test("the generated field is readable through the GraphQL API", async () => {
    const response = await GRAPHQL_POST(payload.config)(
      new Request("http://localhost/api/graphql", {
        body: JSON.stringify({
          query: `query { Media(id: ${mediaID}) { blurHash } }`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect({ body: await response.json(), status: response.status }).toEqual({
      body: { data: { Media: { blurHash } } },
      status: 200,
    });
  });

  test("an eligible replacement stores a new generated BlurHash", async () => {
    const jpeg = await createJpegFixture({ b: 200, g: 160, r: 20 });
    const updated = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: jpeg,
        mimetype: "image/jpeg",
        name: "replacement.jpg",
        size: jpeg.length,
      },
      id: mediaID,
    });

    expect({
      changed: updated.blurHash !== blurHash,
      validation: isBlurhashValid(updated.blurHash ?? ""),
    }).toEqual({ changed: true, validation: { result: true } });
  });

  test("an unsupported replacement clears the previous BlurHash", async () => {
    const text = Buffer.from("not an eligible image");
    const updated = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: text,
        mimetype: "text/plain",
        name: "replacement.txt",
        size: text.length,
      },
      id: mediaID,
    });

    expect(updated.blurHash).toBeNull();
  });

  test("a generation failure clears the BlurHash without failing the upload", async () => {
    const successfulJpeg = await createJpegFixture({ b: 15, g: 45, r: 90 });
    const beforeFailure = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: successfulJpeg,
        mimetype: "image/jpeg",
        name: "before-generation-failure.jpg",
        size: successfulJpeg.length,
      },
      id: mediaID,
    });

    if (typeof beforeFailure.blurHash !== "string") {
      throw new TypeError("Expected the successful upload to generate a BlurHash");
    }

    const failedJpeg = await createJpegFixture({ b: 50, g: 80, r: 120 });
    const afterFailure = await payload.update({
      collection: "media",
      context: { failBlurHashGeneration: true },
      data: {},
      file: {
        data: failedJpeg,
        mimetype: "image/jpeg",
        name: "generation-failure.jpg",
        size: failedJpeg.length,
      },
      id: mediaID,
    });

    expect(afterFailure.blurHash).toBeNull();
  });

  test("removing the file clears the generated BlurHash", async () => {
    const jpeg = await createJpegFixture({ b: 30, g: 70, r: 120 });
    await payload.update({
      collection: "media",
      data: {},
      file: {
        data: jpeg,
        mimetype: "image/jpeg",
        name: "before-removal.jpg",
        size: jpeg.length,
      },
      id: mediaID,
    });

    const updated = await payload.update({
      collection: "media",
      data: {
        filename: null,
        filesize: null,
        height: null,
        mimeType: null,
        thumbnailURL: null,
        url: null,
        width: null,
      },
      id: mediaID,
    });

    expect(updated.blurHash).toBeNull();
  });
});
