import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { decode, isBlurhashValid } from "blurhash";
import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { readImageFixture } from "./image-fixtures.ts";

const decodedDifference = (first: string, second: string) => {
  const firstPixels = decode(first, 32, 32);
  const secondPixels = decode(second, 32, 32);
  let difference = 0;

  for (let offset = 0; offset < firstPixels.length; offset += 4) {
    for (let channel = 0; channel < 3; channel += 1) {
      difference += Math.abs(
        (firstPixels[offset + channel] ?? 0) - (secondPixels[offset + channel] ?? 0),
      );
    }
  }

  return difference / (32 * 32 * 3);
};

describe("JPEG and PNG inputs", () => {
  let payload: Payload;
  let testDirectory: string;
  let uploadSequence = 0;

  const upload = async (
    target: Payload,
    fixtureName: string,
    mimetype: string,
    uploadName: string,
  ) => {
    const data = await readImageFixture(fixtureName);
    uploadSequence += 1;

    return target.create({
      collection: "media",
      data: {},
      file: {
        data,
        mimetype,
        name: `${uploadSequence}-${uploadName}`,
        size: data.length,
      },
    });
  };

  const uploadFixture = (fixtureName: string, mimetype: string) =>
    upload(payload, fixtureName, mimetype, fixtureName);

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-jpeg-png-"));
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
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("an opaque PNG is eligible", async () => {
    const media = await uploadFixture("png-opaque.png", "image/png");

    expect(isBlurhashValid(media.blurHash ?? "")).toEqual({ result: true });
  });

  test("eligible input is encoded at fixed 4 × 3 detail", async () => {
    const media = await uploadFixture("png-opaque.png", "image/png");

    expect(media.blurHash).toHaveLength(28);
  });

  test("an eligible value is decodable", async () => {
    const media = await uploadFixture("png-opaque.png", "image/png");

    expect(decode(media.blurHash ?? "", 4, 3)).toHaveLength(48);
  });

  test.each([
    "jpeg-baseline.jpg",
    "jpeg-progressive.jpg",
    "jpeg-grayscale.jpg",
    "jpeg-cmyk.jpg",
    "jpeg-icc-p3.jpg",
  ])("%s is eligible", async (fixtureName) => {
    const media = await uploadFixture(fixtureName, "image/jpeg");

    expect(isBlurhashValid(media.blurHash ?? "")).toEqual({ result: true });
  });

  test("an alpha PNG is eligible", async () => {
    const media = await uploadFixture("png-alpha-hidden-red.png", "image/png");

    expect(isBlurhashValid(media.blurHash ?? "")).toEqual({ result: true });
  });

  test("a wrong filename extension does not override exact MIME and content agreement", async () => {
    const media = await upload(payload, "jpeg-baseline.jpg", "image/jpeg", "not-an-image.txt");

    expect(isBlurhashValid(media.blurHash ?? "")).toEqual({ result: true });
  });

  test.each(["image/jpg", "IMAGE/JPEG", "image/jpeg; charset=binary"])(
    "the non-exact JPEG MIME %s is not eligible",
    async (mimetype) => {
      const media = await uploadFixture("jpeg-baseline.jpg", mimetype);

      expect(media.blurHash ?? null).toBeNull();
    },
  );

  test.each([
    ["JPEG bytes declared as PNG", "jpeg-baseline.jpg", "image/png"],
    ["PNG bytes declared as JPEG", "png-opaque.png", "image/jpeg"],
    ["a truncated JPEG", "jpeg-truncated.jpg", "image/jpeg"],
    ["a malformed JPEG", "jpeg-malformed.jpg", "image/jpeg"],
    ["a truncated PNG", "png-truncated.png", "image/png"],
    ["a PNG with an invalid CRC", "png-bad-crc.png", "image/png"],
    ["a PNG with its palette after image data", "png-plte-after-idat.png", "image/png"],
    ["a two-frame APNG", "png-apng-two-frame.png", "image/png"],
    ["a one-frame PNG carrying animation control", "png-actl-single-frame.png", "image/png"],
  ])("%s stores null", async (_description, fixtureName, mimetype) => {
    const media = await uploadFixture(fixtureName, mimetype);

    expect(media.blurHash ?? null).toBeNull();
  });

  test("fixed JPEG input and dependencies produce a repeatable value", async () => {
    const first = await uploadFixture("jpeg-baseline.jpg", "image/jpeg");
    const second = await uploadFixture("jpeg-baseline.jpg", "image/jpeg");

    expect({ repeatable: first.blurHash === second.blurHash, value: first.blurHash }).toEqual({
      repeatable: true,
      value: expect.any(String),
    });
  });

  test.each([2, 3, 4, 5, 6, 7, 8])("EXIF orientation %s is normalized", async (orientation) => {
    const oriented = await uploadFixture(`jpeg-orientation-${orientation}.jpg`, "image/jpeg");
    const reference = await uploadFixture(
      `jpeg-orientation-${orientation}-reference.jpg`,
      "image/jpeg",
    );

    expect(decodedDifference(oriented.blurHash ?? "", reference.blurHash ?? "")).toBeLessThan(1);
  });

  test("an embedded Display P3 profile is converted to sRGB", async () => {
    const profiled = await uploadFixture("jpeg-icc-p3.jpg", "image/jpeg");
    const srgb = await uploadFixture("jpeg-baseline.jpg", "image/jpeg");

    expect(decodedDifference(profiled.blurHash ?? "", srgb.blurHash ?? "")).toBeLessThan(2);
  });

  test("fully transparent hidden RGB does not affect the generated value", async () => {
    const hiddenRed = await uploadFixture("png-alpha-hidden-red.png", "image/png");
    const hiddenBlue = await uploadFixture("png-alpha-hidden-blue.png", "image/png");

    expect(hiddenRed.blurHash).toBe(hiddenBlue.blurHash);
  });

  test("alpha uses white as the default opaque background", async () => {
    const alpha = await uploadFixture("png-alpha-hidden-red.png", "image/png");
    const whiteReference = await uploadFixture("png-alpha-white-reference.png", "image/png");

    expect(alpha.blurHash).toBe(whiteReference.blurHash);
  });

  test("an animated PNG replacement clears a generated JPEG value", async () => {
    const created = await uploadFixture("jpeg-baseline.jpg", "image/jpeg");
    const animation = await readImageFixture("png-apng-two-frame.png");
    const replaced = await payload.update({
      collection: "media",
      data: {},
      file: {
        data: animation,
        mimetype: "image/png",
        name: "replacement.png",
        size: animation.length,
      },
      id: created.id,
    });

    expect(replaced.blurHash).toBeNull();
  });
});
