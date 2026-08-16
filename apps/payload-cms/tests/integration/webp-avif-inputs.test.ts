import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode, isBlurhashValid } from "blurhash";
import { getPayload, type Payload } from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { readImageFixture } from "./image-fixtures.ts";

type AppConfig = Awaited<ReturnType<typeof createAppConfig>>;
type GenerationProbe =
  | "avif-decoder-unavailable"
  | "normal"
  | "payload-preserves-input"
  | "webp-multiple-pages";

describe("WebP and AVIF inputs", () => {
  let appConfig: AppConfig;
  let generationProbe: GenerationProbe = "normal";
  let payloadInputFallback: Buffer;
  let payloadInputToPreserve: Buffer | undefined;
  let payload: Payload;
  let testDirectory: string;
  let uploadSequence = 0;

  const controlledSharp: NonNullable<AppConfig["sharp"]> = (input, options) => {
    if (options?.failOn === "warning" && generationProbe === "avif-decoder-unavailable") {
      throw new Error("AVIF decoder unavailable");
    }

    if (
      generationProbe === "payload-preserves-input" &&
      Buffer.isBuffer(input) &&
      payloadInputToPreserve?.equals(input)
    ) {
      const pipeline = sharp(payloadInputFallback, options);
      const preservedInput = Buffer.from(input);
      Object.defineProperty(pipeline, "toBuffer", {
        value: async (outputOptions?: { resolveWithObject?: boolean }) =>
          outputOptions?.resolveWithObject
            ? {
                data: preservedInput,
                info: {
                  channels: 3,
                  format: "heif",
                  height: 24,
                  premultiplied: false,
                  size: preservedInput.length,
                  width: 40,
                },
              }
            : preservedInput,
      });

      return pipeline;
    }

    const pipeline = sharp(input, options);

    if (options?.failOn !== "warning" || generationProbe !== "webp-multiple-pages") {
      return pipeline;
    }

    const readMetadata = pipeline.metadata.bind(pipeline);
    Object.defineProperty(pipeline, "metadata", {
      value: async () => ({ ...(await readMetadata()), pages: 2 }),
    });

    return pipeline;
  };

  const upload = async (fixtureName: string, mimetype: string) => {
    const data = await readImageFixture(fixtureName);
    uploadSequence += 1;

    return payload.create({
      collection: "media",
      data: {},
      file: {
        data,
        mimetype,
        name: `${uploadSequence}-${fixtureName}`,
        size: data.length,
      },
    });
  };

  const replace = async (id: number | string, fixtureName: string, mimetype: string) => {
    const data = await readImageFixture(fixtureName);

    return payload.update({
      collection: "media",
      data: {},
      file: { data, mimetype, name: `replacement-${fixtureName}`, size: data.length },
      id,
    });
  };

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-webp-avif-"));
    payloadInputFallback = await readImageFixture("avif-8-bit.avif");
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false, enabled: true },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedTypesFile: path.join(testDirectory, "payload-types.generated.ts"),
      mediaBeforeChangeHooks: [],
      uploadDirectory: path.join(testDirectory, "media"),
    });
    appConfig = { ...config, sharp: controlledSharp };
    payload = await getPayload({ config: appConfig });
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test.each(["webp-lossy.webp", "webp-lossless.webp", "webp-extended-alpha.webp"])(
    "%s generates a valid value",
    async (fixtureName) => {
      const media = await upload(fixtureName, "image/webp");
      const value = media.blurHash ?? "";

      expect({
        decodedBytes: decode(value, 4, 3).length,
        length: value.length,
        validation: isBlurhashValid(value),
      }).toEqual({ decodedBytes: 48, length: 28, validation: { result: true } });
    },
  );

  test.each(["avif-8-bit.avif", "avif-10-bit.avif"])(
    "%s generates a valid value",
    async (fixtureName) => {
      const media = await upload(fixtureName, "image/avif");
      const value = media.blurHash ?? "";

      expect({
        decodedBytes: decode(value, 4, 3).length,
        length: value.length,
        validation: isBlurhashValid(value),
      }).toEqual({ decodedBytes: 48, length: 28, validation: { result: true } });
    },
  );

  test.each([
    ["animated WebP", "webp-animated.webp", "image/webp"],
    ["WebP bytes declared as JPEG", "webp-lossy.webp", "image/jpeg"],
    ["AVIF bytes declared as PNG", "avif-8-bit.avif", "image/png"],
  ])("%s stores null without rejecting the media write", async (_description, fixture, mime) => {
    const media = await upload(fixture, mime);

    expect(media.blurHash ?? null).toBeNull();
  });

  test.each([
    ["image/webp; charset=binary", "webp-lossy.webp"],
    ["IMAGE/AVIF", "avif-8-bit.avif"],
  ])("the non-exact MIME %s is not eligible", async (mime, fixture) => {
    const media = await upload(fixture, mime);

    expect(media.blurHash ?? null).toBeNull();
  });

  test("an animated WebP replacement clears an existing value", async () => {
    const created = await upload("webp-lossy.webp", "image/webp");
    const replaced = await replace(created.id, "webp-animated.webp", "image/webp");

    expect(replaced.blurHash).toBeNull();
  });

  test("an unavailable AVIF decoder clears an existing value without rejecting replacement", async () => {
    const created = await upload("webp-lossy.webp", "image/webp");
    generationProbe = "avif-decoder-unavailable";
    const replaced = await replace(created.id, "avif-8-bit.avif", "image/avif").finally(() => {
      generationProbe = "normal";
    });

    expect({ blurHash: replaced.blurHash, filename: replaced.filename }).toEqual({
      blurHash: null,
      filename: expect.stringContaining("avif-8-bit"),
    });
  });

  test("decoded WebP page metadata rejects a replacement missed by container markers", async () => {
    const created = await upload("webp-lossy.webp", "image/webp");
    generationProbe = "webp-multiple-pages";
    const replaced = await replace(created.id, "webp-lossy.webp", "image/webp").finally(() => {
      generationProbe = "normal";
    });

    expect({ blurHash: replaced.blurHash, filename: replaced.filename }).toEqual({
      blurHash: null,
      filename: expect.stringContaining("webp-lossy"),
    });
  });

  test.each(["avif-malformed-primary-item.avif", "avif-truncated.avif"])(
    "%s remains a media document with a truthful null value",
    async (fixtureName) => {
      payloadInputToPreserve = await readImageFixture(fixtureName);
      generationProbe = "payload-preserves-input";
      const media = await upload(fixtureName, "image/avif").finally(() => {
        generationProbe = "normal";
        payloadInputToPreserve = undefined;
      });

      expect({ blurHash: media.blurHash, filename: media.filename }).toEqual({
        blurHash: null,
        filename: expect.stringContaining(fixtureName.replace(".avif", "")),
      });
    },
  );
});
