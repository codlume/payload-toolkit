import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SharpDependency } from "payload";
import hostSharp from "sharp";
import { describe, expect, test, vi } from "vitest";

import { createBlurHashGenerator } from "../../src/generate-blur-hash.ts";
import { createConcurrencySharp, createHangingSharp } from "./sharp-test-helpers.ts";

const fixtureDirectory = new URL(
  "../../../../apps/payload-cms/tests/fixtures/images/",
  import.meta.url,
);
const DEFAULT_MAX_INPUT_BYTES = 25 * 1024 * 1024;

const padJpeg = (input: Buffer, targetBytes: number) => {
  let remaining = targetBytes - input.length;
  const parts = [input.subarray(0, 2)];

  while (remaining > 0) {
    let segmentBytes = Math.min(65_537, remaining);
    const tailBytes = remaining - segmentBytes;

    if (tailBytes > 0 && tailBytes < 4) {
      segmentBytes -= 4 - tailBytes;
    }

    if (segmentBytes < 4) {
      throw new RangeError(`Cannot pad JPEG by the remaining ${remaining} bytes`);
    }

    const payloadBytes = segmentBytes - 4;
    const header = Buffer.from([0xff, 0xfe, 0, 0]);
    header.writeUInt16BE(payloadBytes + 2, 2);
    parts.push(header, Buffer.alloc(payloadBytes));
    remaining -= segmentBytes;
  }

  parts.push(input.subarray(2));
  return Buffer.concat(parts, targetBytes);
};

const createSharp = (): SharpDependency => hostSharp;

const createFailingSharp = (): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);
    Object.defineProperty(pipeline, "metadata", {
      value: async () => {
        throw new Error("decoder failed");
      },
    });
    return pipeline;
  }) satisfies SharpDependency;

const createSharpWithoutJpeg = () => {
  const controlledSharp = createFailingSharp();
  Object.defineProperty(controlledSharp, "format", {
    value: { jpeg: { input: { buffer: false } } },
  });
  return controlledSharp;
};

const createFailingNormalizationSharp = (): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (!options?.animated) {
      Object.defineProperty(pipeline, "rotate", {
        value: () => {
          throw new Error("normalization failed");
        },
      });
    }

    return pipeline;
  }) satisfies SharpDependency;

const createInvalidPixelsSharp = (): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (!options?.animated) {
      Object.defineProperty(pipeline, "toBuffer", {
        value: async () => ({
          data: Buffer.alloc(0),
          info: { channels: 4, height: 2, width: 2 },
        }),
      });
    }

    return pipeline;
  }) satisfies SharpDependency;

const createSharpMissingOnlyJpeg = (): SharpDependency => {
  const controlledSharp = ((input, options) => hostSharp(input, options)) satisfies SharpDependency;
  Object.defineProperty(controlledSharp, "format", {
    value: {
      jpeg: { input: { buffer: false } },
      png: { input: { buffer: true } },
    },
  });
  return controlledSharp;
};

const createRecoveringSharp = (): SharpDependency => {
  let metadataAttempts = 0;

  return ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      const metadata = pipeline.metadata.bind(pipeline);
      Object.defineProperty(pipeline, "metadata", {
        value: async () => {
          metadataAttempts += 1;

          if (metadataAttempts === 1) {
            throw new Error("first decode failed");
          }

          return metadata();
        },
      });
    }

    return pipeline;
  }) satisfies SharpDependency;
};

const createSlowThenSuccessfulSharp = (): SharpDependency => {
  let metadataAttempts = 0;

  return ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      const metadata = pipeline.metadata.bind(pipeline);
      Object.defineProperty(pipeline, "metadata", {
        value: async () => {
          metadataAttempts += 1;

          if (metadataAttempts === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
          }

          return metadata();
        },
      });
    }

    return pipeline;
  }) satisfies SharpDependency;
};

const createAnimatedMetadataSharp = (): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      const metadata = pipeline.metadata.bind(pipeline);
      Object.defineProperty(pipeline, "metadata", {
        value: async () => ({ ...(await metadata()), pages: 2 }),
      });
    }

    return pipeline;
  }) satisfies SharpDependency;

const createMetadataSharp = (width: number, height: number): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      Object.defineProperty(pipeline, "metadata", {
        value: async () => ({ format: "jpeg", height, pages: 1, width }),
      });
    }

    return pipeline;
  }) satisfies SharpDependency;

const createTestGenerator = ({
  sharp,
  ...options
}: Parameters<typeof createBlurHashGenerator>[0] & { sharp: SharpDependency }) => {
  const generator = createBlurHashGenerator(options);

  return {
    generate: (input: Buffer, mimeType: unknown) => generator.generate({ input, mimeType, sharp }),
  };
};

const createGenerator = (maxInputBytes: number) =>
  createTestGenerator({
    alphaBackground: { b: 255, g: 255, r: 255 },
    limits: {
      concurrency: 2,
      maxInputBytes,
      maxInputPixels: 960,
      maxInputSide: 40,
      timeoutSeconds: 10,
    },
    sharp: createSharp(),
  });

describe("createBlurHashGenerator", () => {
  test("generates when input is exactly at its byte, pixel, and side limits", async () => {
    const source = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-limit-"));
    const fixturePath = path.join(testDirectory, "at-byte-limit.jpg");

    try {
      await writeFile(fixturePath, padJpeg(source, DEFAULT_MAX_INPUT_BYTES));
      const input = await readFile(fixturePath);
      const outcome = await createGenerator(DEFAULT_MAX_INPUT_BYTES).generate(input, "image/jpeg");

      expect(outcome).toMatchObject({ status: "generated", value: expect.any(String) });
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  test("rejects compressed input over the configured byte limit", async () => {
    const generator = createGenerator(DEFAULT_MAX_INPUT_BYTES);

    expect(
      await generator.generate(Buffer.alloc(DEFAULT_MAX_INPUT_BYTES + 1), "image/jpeg"),
    ).toEqual({ code: "input_too_large", status: "failed" });
  });

  test("rejects decoded dimensions over the configured side limit", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 39,
        timeoutSeconds: 10,
      },
      sharp: createSharp(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "input_too_large",
      status: "failed",
    });
  });

  test("rejects decoded dimensions over the configured pixel limit", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 959,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createSharp(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "input_too_large",
      status: "failed",
    });
  });

  test("honors explicit resource limits above every default without hidden ceilings", async () => {
    const source = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const overrideLimit = 40_000_001;
    const input = padJpeg(source, DEFAULT_MAX_INPUT_BYTES + 1);
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 3,
        maxInputBytes: input.length,
        maxInputPixels: overrideLimit,
        maxInputSide: overrideLimit,
        timeoutSeconds: 11,
      },
      sharp: createMetadataSharp(overrideLimit, 1),
    });

    expect(await generator.generate(input, "image/jpeg")).toMatchObject({
      status: "generated",
      value: expect.any(String),
    });
  });

  test("settles decoder errors as decode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createFailingSharp(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "decode_failed",
      status: "failed",
    });
  });

  test("settles decoded multi-page input as an animation skip", async () => {
    const input = await readFile(new URL("webp-lossy.webp", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createAnimatedMetadataSharp(),
    });

    expect(await generator.generate(input, "image/webp")).toEqual({
      code: "animated_input",
      status: "skipped",
    });
  });

  test("settles a missing format decoder without calling it", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createSharpWithoutJpeg(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "decoder_unavailable",
      status: "failed",
    });
  });

  test("a missing decoder does not prevent another format from generating", async () => {
    const jpeg = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const png = await readFile(new URL("png-opaque.png", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: Math.max(jpeg.length, png.length),
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createSharpMissingOnlyJpeg(),
    });

    expect(
      await Promise.all([
        generator.generate(jpeg, "image/jpeg"),
        generator.generate(png, "image/png"),
      ]),
    ).toEqual([
      { code: "decoder_unavailable", status: "failed" },
      { status: "generated", value: expect.any(String) },
    ]);
  });

  test("settles normalization errors as decode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createFailingNormalizationSharp(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "decode_failed",
      status: "failed",
    });
  });

  test("settles encoder errors as encode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createInvalidPixelsSharp(),
    });

    expect(await generator.generate(input, "image/jpeg")).toEqual({
      code: "encode_failed",
      status: "failed",
    });
  });

  test("settles work that exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 1,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 1,
      },
      sharp: createHangingSharp(),
    });
    let observed: unknown;

    void generator.generate(input, "image/jpeg").then((outcome) => {
      observed = outcome;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    let queuedObserved: unknown;
    void generator.generate(input, "image/jpeg").then((outcome) => {
      queuedObserved = outcome;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();

    expect({ observed, queuedObserved }).toEqual({
      observed: { code: "decode_timeout", status: "failed" },
      queuedObserved: { code: "decode_timeout", status: "failed" },
    });
  });

  test("never starts more than the configured number of generations", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    let maximumActive = 0;
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 2,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createConcurrencySharp((active) => {
        maximumActive = Math.max(maximumActive, active);
      }),
    });

    await Promise.all([
      generator.generate(input, "image/jpeg"),
      generator.generate(input, "image/jpeg"),
      generator.generate(input, "image/jpeg"),
    ]);

    expect(maximumActive).toBe(2);
  });

  test("continues queued work after a failed generation", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const generator = createTestGenerator({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 1,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createRecoveringSharp(),
    });

    expect(
      await Promise.all([
        generator.generate(input, "image/jpeg"),
        generator.generate(input, "image/jpeg"),
      ]),
    ).toEqual([
      { code: "decode_failed", status: "failed" },
      { status: "generated", value: expect.any(String) },
    ]);
  });

  test("continues queued work after a timed-out generation settles", async () => {
    vi.useFakeTimers();

    try {
      const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
      const generator = createTestGenerator({
        alphaBackground: { b: 255, g: 255, r: 255 },
        limits: {
          concurrency: 1,
          maxInputBytes: input.length,
          maxInputPixels: 960,
          maxInputSide: 40,
          timeoutSeconds: 1,
        },
        sharp: createSlowThenSuccessfulSharp(),
      });
      const first = generator.generate(input, "image/jpeg");
      await vi.advanceTimersByTimeAsync(1_000);
      const second = generator.generate(input, "image/jpeg");
      await vi.advanceTimersByTimeAsync(500);

      expect({ first: await first, second: await second }).toEqual({
        first: { code: "decode_timeout", status: "failed" },
        second: { status: "generated", value: expect.any(String) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test.each([
    ["jpeg-baseline.jpg", "image/jpg", { code: "not_eligible", status: "skipped" }],
    ["png-apng-two-frame.png", "image/png", { code: "animated_input", status: "skipped" }],
    ["jpeg-malformed.jpg", "image/jpeg", { code: "malformed_container", status: "failed" }],
    ["png-opaque.png", "image/jpeg", { code: "type_mismatch", status: "failed" }],
  ])("settles %s with the stable outcome for %s", async (fixture, mimeType, expected) => {
    const input = await readFile(new URL(fixture, fixtureDirectory));

    expect(await createGenerator(input.length).generate(input, mimeType)).toEqual(expected);
  });
});
