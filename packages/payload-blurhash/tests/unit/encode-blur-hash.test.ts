import { decode, isBlurhashValid } from "blurhash";
import { describe, expect, test } from "vitest";

import { encodeBlurHash } from "../../src/encode-blur-hash.ts";

describe("encodeBlurHash", () => {
  test("encodes RGBA pixels at fixed 4 × 3 detail", () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
    ]);

    const hash = encodeBlurHash(pixels, 2, 2);
    const decoded = decode(hash, 2, 2);

    expect({
      decodedPixels: decoded.length,
      length: hash.length,
      sizeFlag: hash[0],
      validation: isBlurhashValid(hash),
    }).toEqual({
      decodedPixels: 16,
      length: 28,
      sizeFlag: "L",
      validation: { result: true },
    });
  });
});
