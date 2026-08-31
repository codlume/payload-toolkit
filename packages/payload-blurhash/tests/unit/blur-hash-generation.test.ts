import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { isBlurhashValid } from "blurhash";
import type { FieldHook, PayloadLogger, SharpDependency } from "payload";
import hostSharp from "sharp";
import { describe, expect, test, vi } from "vitest";

import { createBlurHashGeneration } from "../../src/blur-hash-generation.ts";
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

const createTestHook = ({
  sharp,
  ...options
}: Omit<Parameters<typeof createBlurHashGeneration>[0], "debug" | "enabled"> & {
  sharp: SharpDependency;
}) => createBlurHashGeneration({ ...options, debug: true, enabled: true, sharp })("media");

const createHook = (maxInputBytes: number) =>
  createTestHook({
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const createLogger = () => ({ debug: vi.fn(), warn: vi.fn() });

const invokeHook = (
  hook: FieldHook,
  {
    data,
    file,
    logger = createLogger(),
    previousValue,
    sharp,
  }: {
    data?: Record<string, unknown>;
    file?: { data: Buffer; name?: string; size?: number; tempFilePath?: string };
    logger?: Pick<PayloadLogger, "debug" | "warn">;
    previousValue?: unknown;
    sharp?: SharpDependency;
  },
) =>
  Reflect.apply(hook, undefined, [
    {
      data,
      previousValue,
      req: {
        file,
        payload: {
          config: sharp ? { sharp } : {},
          logger,
        },
      },
    },
  ]);

const runGeneration = async (hook: FieldHook, input: Buffer, mimeType: unknown) => {
  const logger = createLogger();
  const value = await invokeHook(hook, {
    data: { mimeType },
    file: { data: input },
    logger,
  });
  const diagnostic = [...logger.debug.mock.calls, ...logger.warn.mock.calls]
    .map(([entry]) => entry)
    .find((entry) => isRecord(entry) && typeof entry.code === "string");

  if (isRecord(diagnostic) && typeof diagnostic.code === "string") {
    return {
      code: diagnostic.code,
      status: diagnostic.event === "generation_skipped" ? "skipped" : "failed",
    };
  }

  return typeof value === "string" ? { status: "generated", value } : value;
};

describe("BlurHash generation", () => {
  test("generates when input is exactly at its byte, pixel, and side limits", async () => {
    const source = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-limit-"));
    const fixturePath = path.join(testDirectory, "at-byte-limit.jpg");

    try {
      await writeFile(fixturePath, padJpeg(source, DEFAULT_MAX_INPUT_BYTES));
      const input = await readFile(fixturePath);
      const outcome = await runGeneration(createHook(DEFAULT_MAX_INPUT_BYTES), input, "image/jpeg");

      expect(
        isRecord(outcome) && outcome.status === "generated" && typeof outcome.value === "string"
          ? {
              length: outcome.value.length,
              sizeFlag: outcome.value[0],
              valid: isBlurhashValid(outcome.value).result,
            }
          : outcome,
      ).toEqual({ length: 28, sizeFlag: "L", valid: true });
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  test("rejects compressed input over the configured byte limit", async () => {
    const hook = createHook(DEFAULT_MAX_INPUT_BYTES);

    expect(
      await runGeneration(hook, Buffer.alloc(DEFAULT_MAX_INPUT_BYTES + 1), "image/jpeg"),
    ).toEqual({ code: "input_too_large", status: "failed" });
  });

  test("rejects decoded dimensions over the configured side limit", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "input_too_large",
      status: "failed",
    });
  });

  test("rejects decoded dimensions over the configured pixel limit", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "input_too_large",
      status: "failed",
    });
  });

  test("honors explicit resource limits above every default without hidden ceilings", async () => {
    const source = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const overrideLimit = 40_000_001;
    const input = padJpeg(source, DEFAULT_MAX_INPUT_BYTES + 1);
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toMatchObject({
      status: "generated",
      value: expect.any(String),
    });
  });

  test("settles decoder errors as decode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "decode_failed",
      status: "failed",
    });
  });

  test("settles decoded multi-page input as an animation skip", async () => {
    const input = await readFile(new URL("webp-lossy.webp", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/webp")).toEqual({
      code: "animated_input",
      status: "skipped",
    });
  });

  test("settles a missing format decoder without calling it", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "decoder_unavailable",
      status: "failed",
    });
  });

  test("a missing decoder does not prevent another format from generating", async () => {
    const jpeg = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const png = await readFile(new URL("png-opaque.png", fixtureDirectory));
    const hook = createTestHook({
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
        runGeneration(hook, jpeg, "image/jpeg"),
        runGeneration(hook, png, "image/png"),
      ]),
    ).toEqual([
      { code: "decoder_unavailable", status: "failed" },
      { status: "generated", value: expect.any(String) },
    ]);
  });

  test("settles normalization errors as decode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "decode_failed",
      status: "failed",
    });
  });

  test("settles encoder errors as encode failures", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    expect(await runGeneration(hook, input, "image/jpeg")).toEqual({
      code: "encode_failed",
      status: "failed",
    });
  });

  test("settles work that exceeds the configured timeout", async () => {
    vi.useFakeTimers();
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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

    void runGeneration(hook, input, "image/jpeg").then((outcome) => {
      observed = outcome;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    let queuedObserved: unknown;
    void runGeneration(hook, input, "image/jpeg").then((outcome) => {
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
    const hook = createTestHook({
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
      runGeneration(hook, input, "image/jpeg"),
      runGeneration(hook, input, "image/jpeg"),
      runGeneration(hook, input, "image/jpeg"),
    ]);

    expect(maximumActive).toBe(2);
  });

  test("continues queued work after a failed generation", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
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
        runGeneration(hook, input, "image/jpeg"),
        runGeneration(hook, input, "image/jpeg"),
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
      const hook = createTestHook({
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
      const first = runGeneration(hook, input, "image/jpeg");
      await vi.advanceTimersByTimeAsync(1_000);
      const second = runGeneration(hook, input, "image/jpeg");
      await vi.advanceTimersByTimeAsync(500);

      expect({ first: await first, second: await second }).toEqual({
        first: { code: "decode_timeout", status: "failed" },
        second: { status: "generated", value: expect.any(String) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  test("handles removal, missing files, and disabled generation before diagnostics", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const logger = createLogger();
    const enabledHook = createHook(input.length);
    const disabledHook = createBlurHashGeneration({
      alphaBackground: { b: 255, g: 255, r: 255 },
      debug: true,
      enabled: false,
      limits: {
        concurrency: 1,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: undefined,
    })("media");

    expect({
      disabled: await invokeHook(disabledHook, {
        data: { mimeType: "image/jpeg" },
        file: { data: input },
        logger,
        previousValue: "old-hash",
      }),
      missingOnCreate: await invokeHook(enabledHook, { logger }),
      removal: await invokeHook(enabledHook, {
        data: { filename: null, mimeType: "image/jpeg" },
        file: { data: input },
        logger,
        previousValue: "old-hash",
      }),
      updateWithoutFile: await invokeHook(enabledHook, {
        logger,
        previousValue: "old-hash",
      }),
      logs: logger.debug.mock.calls.length + logger.warn.mock.calls.length,
    }).toEqual({
      disabled: null,
      logs: 0,
      missingOnCreate: null,
      removal: null,
      updateWithoutFile: "old-hash",
    });
  });

  test("prefers the request Sharp adapter over the registration fallback", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createTestHook({
      alphaBackground: { b: 255, g: 255, r: 255 },
      limits: {
        concurrency: 1,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createFailingSharp(),
    });
    const result = await invokeHook(hook, {
      data: { mimeType: "image/jpeg" },
      file: { data: input },
      sharp: hostSharp,
    });

    expect(typeof result === "string" && isBlurhashValid(result).result).toBe(true);
  });

  test("uses a temporary upload path and isolates a missing path", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-generation-"));
    const fixturePath = path.join(testDirectory, "upload.jpg");
    const missingPath = path.join(testDirectory, "missing.jpg");

    try {
      await writeFile(fixturePath, input);
      const hook = createHook(input.length);
      const logger = createLogger();
      const generated = await invokeHook(hook, {
        data: { mimeType: "image/jpeg" },
        file: {
          data: Buffer.from("stale invalid bytes"),
          size: input.length,
          tempFilePath: fixturePath,
        },
        logger,
      });
      const failed = await invokeHook(hook, {
        data: { mimeType: "image/jpeg" },
        file: { data: Buffer.alloc(0), size: 321, tempFilePath: missingPath },
        logger,
      });

      expect({
        failed,
        generated: typeof generated === "string" && isBlurhashValid(generated).result,
        warning: logger.warn.mock.calls.at(-1)?.[0],
      }).toMatchObject({
        failed: null,
        generated: true,
        warning: {
          code: "decode_failed",
          event: "generation_failed",
          inputBytes: 321,
          stage: "decode",
        },
      });
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  test("rejects an oversized temporary upload before reading it", async () => {
    const testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-generation-limit-"));
    const fixturePath = path.join(testDirectory, "oversized.jpg");
    const logger = createLogger();

    try {
      await writeFile(fixturePath, Buffer.alloc(5));
      const hook = createHook(4);
      const result = await invokeHook(hook, {
        data: { mimeType: "image/jpeg" },
        file: { data: Buffer.alloc(0), size: 1, tempFilePath: fixturePath },
        logger,
      });

      expect({ result, warning: logger.warn.mock.calls[0]?.[0] }).toMatchObject({
        result: null,
        warning: {
          code: "input_too_large",
          event: "generation_failed",
          inputBytes: 5,
          stage: "limits",
        },
      });
    } finally {
      await rm(testDirectory, { force: true, recursive: true });
    }
  });

  test("bounds skipped diagnostics and omits private upload data", async () => {
    const input = Buffer.from("private upload bytes");
    const mimeType = `text/${"x".repeat(200)}`;
    const logger = createLogger();
    const hook = createHook(input.length);
    const result = await invokeHook(hook, {
      data: { height: 20, metadata: "private metadata", mimeType, width: 30 },
      file: { data: input, name: "private-name.txt" },
      logger,
    });
    const serialized = JSON.stringify(logger.debug.mock.calls);

    expect({
      leaked: [input.toString(), "private-name.txt", "private metadata"].filter((value) =>
        serialized.includes(value),
      ),
      result,
      skipped: logger.debug.mock.calls.at(-1)?.[0],
    }).toMatchObject({
      leaked: [],
      result: null,
      skipped: {
        code: "not_eligible",
        event: "generation_skipped",
        height: 20,
        mimeType: mimeType.slice(0, 128),
        stage: "inspect",
        width: 30,
      },
    });
  });

  test("warns once per unavailable decoder across collection hooks", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const createHookForCollection = createBlurHashGeneration({
      alphaBackground: { b: 255, g: 255, r: 255 },
      debug: false,
      enabled: true,
      limits: {
        concurrency: 1,
        maxInputBytes: input.length,
        maxInputPixels: 960,
        maxInputSide: 40,
        timeoutSeconds: 10,
      },
      sharp: createSharpWithoutJpeg(),
    });
    const firstLogger = createLogger();
    const secondLogger = createLogger();

    await invokeHook(createHookForCollection("media"), {
      data: { mimeType: "image/jpeg" },
      file: { data: input },
      logger: firstLogger,
    });
    await invokeHook(createHookForCollection("assets"), {
      data: { mimeType: "image/jpeg" },
      file: { data: input },
      logger: secondLogger,
    });

    expect({
      first: firstLogger.warn.mock.calls.map(([entry]) => entry),
      second: secondLogger.warn.mock.calls,
    }).toMatchObject({
      first: [
        {
          code: "decoder_unavailable",
          event: "generation_failed",
          stage: "decode",
        },
      ],
      second: [],
    });
  });

  test("keeps BlurHash generation working when the logger throws", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const hook = createHook(input.length);
    const result = await invokeHook(hook, {
      data: { mimeType: "image/jpeg" },
      file: { data: input },
      logger: {
        debug: () => {
          throw new Error("logger unavailable");
        },
        warn: () => {
          throw new Error("logger unavailable");
        },
      },
    });

    expect(typeof result === "string" && isBlurhashValid(result).result).toBe(true);
  });

  test.each([
    ["jpeg-baseline.jpg", "image/jpg", { code: "not_eligible", status: "skipped" }],
    ["png-apng-two-frame.png", "image/png", { code: "animated_input", status: "skipped" }],
    ["jpeg-malformed.jpg", "image/jpeg", { code: "malformed_container", status: "failed" }],
    ["png-opaque.png", "image/jpeg", { code: "type_mismatch", status: "failed" }],
  ])("settles %s with the stable outcome for %s", async (fixture, mimeType, expected) => {
    const input = await readFile(new URL(fixture, fixtureDirectory));

    expect(await runGeneration(createHook(input.length), input, mimeType)).toEqual(expected);
  });
});
