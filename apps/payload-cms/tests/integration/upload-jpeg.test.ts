import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { GRAPHQL_POST } from "@payloadcms/next/routes";
import { isBlurhashValid } from "blurhash";
import { getPayload, handleEndpoints, type Payload } from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, expectTypeOf, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import type { Media } from "../../src/payload-types.generated.ts";

describe("JPEG uploads", () => {
  let blurHash: string;
  let mediaID: number | string;
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-"));
    const config = await createAppConfig({
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    payload = await getPayload({ config });
    const jpeg = await sharp({
      create: {
        background: { b: 80, g: 40, r: 200 },
        channels: 3,
        height: 12,
        width: 16,
      },
    })
      .jpeg()
      .toBuffer();

    const created = await payload.create({
      collection: "media",
      data: {},
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

  test("the generated collection type exposes a nullable BlurHash string", () => {
    expectTypeOf<Exclude<Media["blurHash"], undefined>>().toEqualTypeOf<string | null>();
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

    expect({
      hash: media.blurHash,
      length: media.blurHash?.length,
      validation: isBlurhashValid(media.blurHash ?? ""),
    }).toEqual({
      hash: blurHash,
      length: 28,
      validation: { result: true },
    });
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
});
