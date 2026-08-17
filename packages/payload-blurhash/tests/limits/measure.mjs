import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, getPayload } from "payload";
import sharp from "sharp";

import { blurHashPlugin } from "@codlume/payload-blurhash";
import { runCommand } from "../../../../tests/limits/run-command.mjs";

process.env.NODE_ENV = "test";
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = "true";

const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_INPUT_SIDE = 16_384;
const MEMORY_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const MEMORY_THRESHOLD_BYTES = 1.5 * 1024 * 1024 * 1024;
const SUCCESS_THRESHOLD_MS = 5_000;
const RECORDED_EXECUTIONS = 5;
const WARM_UP_EXECUTIONS = 1;
const DEFAULT_CONCURRENCY = 2;
const scriptPath = fileURLToPath(import.meta.url);

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const round = (value) => Math.round(value * 100) / 100;

const mapSequentially = (values, callback) =>
  values.reduce(
    async (collectedPromise, value, index) => [
      ...(await collectedPromise),
      await callback(value, index),
    ],
    Promise.resolve([]),
  );

const padJpeg = (input, targetBytes) => {
  let remaining = targetBytes - input.length;
  const parts = [input.subarray(0, 2)];

  while (remaining > 0) {
    let segmentBytes = Math.min(65_537, remaining);
    const tailBytes = remaining - segmentBytes;

    if (tailBytes > 0 && tailBytes < 4) {
      segmentBytes -= 4 - tailBytes;
    }

    assert(segmentBytes >= 4, `Cannot pad JPEG by the remaining ${remaining} bytes`);
    const payloadBytes = segmentBytes - 4;
    const header = Buffer.from([0xff, 0xfe, 0, 0]);
    header.writeUInt16BE(payloadBytes + 2, 2);
    parts.push(header, Buffer.alloc(payloadBytes));
    remaining -= segmentBytes;
  }

  parts.push(input.subarray(2));
  return Buffer.concat(parts, targetBytes);
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

const pngCrc = (type, data) => {
  let crc = 0xffffffff;

  for (const byte of Buffer.concat([type, data])) {
    crc = (crcTable[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const padPng = (input, targetBytes) => {
  const chunkDataBytes = targetBytes - input.length - 12;
  assert(chunkDataBytes >= 0, `PNG is too large to pad to ${targetBytes} bytes`);
  const iend = input.subarray(input.length - 12);
  assert(iend.subarray(4, 8).toString("ascii") === "IEND", "PNG does not end with IEND");
  const type = Buffer.from("raNd");
  const data = Buffer.alloc(chunkDataBytes);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.length, 0);
  type.copy(header, 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc(type, data));
  return Buffer.concat([input.subarray(0, -12), header, data, crc, iend], targetBytes);
};

const generateFixtures = async (directory) => {
  await mkdir(directory, { recursive: true });
  const jpeg = await sharp({
    create: {
      background: { b: 96, g: 64, r: 32 },
      channels: 3,
      height: 24,
      width: 40,
    },
  })
    .jpeg()
    .toBuffer();
  await writeFile(path.join(directory, "bytes-at.jpg"), padJpeg(jpeg, MAX_INPUT_BYTES));
  await writeFile(path.join(directory, "bytes-over.jpg"), padJpeg(jpeg, MAX_INPUT_BYTES + 1));

  const highEntropyPixels = Buffer.alloc(MAX_INPUT_PIXELS * 4);
  let randomState = 0x6d2b79f5;

  for (let offset = 0; offset < highEntropyPixels.length; offset += 4) {
    randomState = Math.imul(randomState ^ (randomState >>> 15), randomState | 1);
    randomState ^= randomState + Math.imul(randomState ^ (randomState >>> 7), randomState | 61);
    const randomBits = randomState ^ (randomState >>> 14);
    highEntropyPixels[offset] = (randomBits & 1) * 255;
    highEntropyPixels[offset + 1] = ((randomBits >>> 1) & 1) * 255;
    highEntropyPixels[offset + 2] = ((randomBits >>> 2) & 1) * 255;
    highEntropyPixels[offset + 3] = 255;
  }

  const pixelBoundaryPng = await sharp(highEntropyPixels, {
    raw: { channels: 4, height: 5_000, width: 8_000 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(
    path.join(directory, "pixels-and-bytes-at.png"),
    padPng(pixelBoundaryPng, MAX_INPUT_BYTES),
  );

  await mapSequentially(
    [
      ["pixels-over.png", 8_000, 5_001],
      ["side-at.png", MAX_INPUT_SIDE, 1],
      ["side-over.png", MAX_INPUT_SIDE + 1, 1],
    ],
    ([name, width, height]) =>
      sharp({
        create: {
          background: { alpha: 1, b: 96, g: 64, r: 32 },
          channels: 4,
          height,
          width,
        },
      })
        .png({ compressionLevel: 1 })
        .toFile(path.join(directory, name)),
  );
};

const readControlledEnvironment = async () => {
  const [cpuMax, memoryMax] = await Promise.all([
    readFile("/sys/fs/cgroup/cpu.max", "utf8"),
    readFile("/sys/fs/cgroup/memory.max", "utf8"),
  ]);
  const [quotaValue, periodValue] = cpuMax.trim().split(/\s+/u);
  const quota = Number(quotaValue);
  const period = Number(periodValue);
  const memoryLimitBytes = Number(memoryMax.trim());
  const cpuLimit = quota / period;

  assert(Number.isFinite(cpuLimit) && cpuLimit > 0 && cpuLimit <= 2, "Expected a 2-vCPU cap");
  assert(
    Number.isSafeInteger(memoryLimitBytes) && memoryLimitBytes <= MEMORY_LIMIT_BYTES,
    "Expected a 2-GiB memory cap",
  );
  assert(availableParallelism() <= 2, "Node observes more than two available processors");

  return {
    architecture: process.arch,
    availableProcessors: availableParallelism(),
    cpuLimit,
    memoryLimitBytes,
    node: process.version,
    platform: process.platform,
  };
};

const createPeakMemorySampler = () => {
  let peakMemoryBytes = process.memoryUsage().rss;
  const timer = setInterval(() => {
    peakMemoryBytes = Math.max(peakMemoryBytes, process.memoryUsage().rss);
  }, 1);

  return () => {
    clearInterval(timer);
    return Math.max(peakMemoryBytes, process.memoryUsage().rss);
  };
};

const stopDecodeClock = (token) => {
  if (token.decodeStartedAt === undefined) {
    return;
  }

  token.metrics.decodeDurationMs += performance.now() - token.decodeStartedAt;
  token.decodeStartedAt = undefined;
};

const createInstrumentedSharp = (hangMetadata) => {
  let activeGenerations = 0;
  let maximumActiveGenerations = 0;
  const awaitingDiagnostics = [];
  const awaitingDecode = [];
  const activeByInput = new WeakMap();
  const trackedTokens = new Set();

  const finish = (token) => {
    if (!token.metrics.active) {
      return;
    }

    token.metrics.active = false;
    activeGenerations -= 1;
  };

  const controlledSharp = (input, options) => {
    const pipeline = sharp(input, options);
    const isGenerationMetadata = options?.animated === true && options.failOn === "warning";

    if (isGenerationMetadata) {
      const token = awaitingDecode.shift();

      if (token) {
        token.metrics.preDecodeDurationMs = performance.now() - token.queueStartedAt;
        token.metrics.active = true;
        activeGenerations += 1;
        maximumActiveGenerations = Math.max(maximumActiveGenerations, activeGenerations);
        activeByInput.set(input, [...(activeByInput.get(input) ?? []), token]);
        const metadata = pipeline.metadata.bind(pipeline);

        Object.defineProperty(pipeline, "metadata", {
          value: async () => {
            token.decodeStartedAt = performance.now();

            try {
              return hangMetadata ? await new Promise(() => undefined) : await metadata();
            } finally {
              stopDecodeClock(token);
            }
          },
        });
      }
    } else if (!options?.animated && Buffer.isBuffer(input)) {
      const token = activeByInput.get(input)?.find(({ metrics }) => metrics.active);

      if (token) {
        const toBuffer = pipeline.toBuffer.bind(pipeline);
        Object.defineProperty(pipeline, "toBuffer", {
          value: async (...arguments_) => {
            const startedAt = performance.now();

            try {
              return await Reflect.apply(toBuffer, pipeline, arguments_);
            } finally {
              token.metrics.decodeDurationMs += performance.now() - startedAt;
              finish(token);
            }
          },
        });
      }
    }

    return pipeline;
  };
  Object.defineProperty(controlledSharp, "format", { get: () => sharp.format });

  return {
    dependency: controlledSharp,
    maximumActiveGenerations: () => maximumActiveGenerations,
    recordDiagnostic: (entry) => {
      if (entry.code === "decode_timeout") {
        const token = [...trackedTokens].find(
          ({ decodeStartedAt }) => decodeStartedAt !== undefined,
        );
        if (token) {
          stopDecodeClock(token);
        }
        return;
      }

      if (entry.event !== "generation_started") {
        return;
      }

      const token = awaitingDiagnostics.shift();

      if (token) {
        token.queueStartedAt = performance.now();
        awaitingDecode.push(token);
      }
    },
    register: () => {
      const token = {
        decodeStartedAt: undefined,
        metrics: { active: false, decodeDurationMs: 0, preDecodeDurationMs: 0 },
        queueStartedAt: undefined,
      };
      awaitingDiagnostics.push(token);
      trackedTokens.add(token);
      return token;
    },
    resetMaximumActiveGenerations: () => {
      maximumActiveGenerations = activeGenerations;
    },
    settle: (token) => {
      const diagnosticIndex = awaitingDiagnostics.indexOf(token);

      if (diagnosticIndex >= 0) {
        awaitingDiagnostics.splice(diagnosticIndex, 1);
      }

      const decodeIndex = awaitingDecode.indexOf(token);

      if (decodeIndex >= 0) {
        awaitingDecode.splice(decodeIndex, 1);
      }

      stopDecodeClock(token);
      finish(token);
      trackedTokens.delete(token);
      return token.metrics;
    },
  };
};

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const startPayloadHarness = async ({ directory, hangMetadata = false, limits, name }) => {
  const stateDirectory = path.join(directory, name);
  await mkdir(stateDirectory, { recursive: true });
  const instrumentation = createInstrumentedSharp(hangMetadata);
  const plugin = blurHashPlugin({
    collections: ["media"],
    debug: true,
    ...(limits ? { limits } : {}),
  });
  const config = await buildConfig({
    collections: [
      {
        fields: [],
        slug: "media",
        upload: { staticDir: path.join(stateDirectory, "media") },
      },
    ],
    db: sqliteAdapter({
      client: { url: `file:${path.join(stateDirectory, "payload.db")}` },
      push: true,
    }),
    plugins: [plugin],
    secret: "payload-blurhash-limits-secret",
    sharp: instrumentation.dependency,
    telemetry: false,
  });
  const payload = await getPayload({ config, key: stateDirectory });
  const diagnostics = [];

  for (const level of ["debug", "warn"]) {
    const original = payload.logger[level].bind(payload.logger);
    payload.logger[level] = (entry, ...arguments_) => {
      if (isRecord(entry) && entry.plugin === "blurhash") {
        diagnostics.push(entry);
        instrumentation.recordDiagnostic(entry);
        return;
      }

      Reflect.apply(original, payload.logger, [entry, ...arguments_]);
    };
  }

  let uploadNumber = 0;

  return {
    beginMeasurement: instrumentation.register,
    create: async ({ input, mimeType }) => {
      const diagnosticsStart = diagnostics.length;
      uploadNumber += 1;
      const extension = mimeType === "image/jpeg" ? "jpg" : "png";
      const media = await payload.create({
        collection: "media",
        data: {},
        file: {
          data: input,
          mimetype: mimeType,
          name: `limits-${uploadNumber}.${extension}`,
          size: input.length,
        },
      });

      return { diagnostics: diagnostics.slice(diagnosticsStart), value: media.blurHash };
    },
    destroy: () => payload.destroy(),
    finishMeasurement: instrumentation.settle,
    readPeakActiveGenerations: instrumentation.maximumActiveGenerations,
    resetPeakActiveGenerations: instrumentation.resetMaximumActiveGenerations,
  };
};

const readOutcomeCode = (value, diagnostics) => {
  if (typeof value === "string") {
    return "generated";
  }

  const completed = diagnostics.findLast(
    (entry) => entry.event === "generation_failed" || entry.event === "generation_skipped",
  );
  return typeof completed?.code === "string" ? completed.code : "unknown";
};

const runBatch = async ({ copies, dimensions, harness, input, mimeType }) => {
  globalThis.gc?.();
  harness.resetPeakActiveGenerations();
  const stopMemorySampler = createPeakMemorySampler();
  const batchStartedAt = performance.now();
  const measurements = await Promise.all(
    Array.from({ length: copies }, async () => {
      const uploadInput = Buffer.from(input);
      const token = harness.beginMeasurement();
      const startedAt = performance.now();
      const { diagnostics, value } = await harness.create({ input: uploadInput, mimeType });
      const totalDurationMs = performance.now() - startedAt;
      const metrics = harness.finishMeasurement(token);
      return {
        decodeDurationMs: metrics.decodeDurationMs,
        outcomeCode: readOutcomeCode(value, diagnostics),
        preDecodeDurationMs: metrics.preDecodeDurationMs,
        totalDurationMs,
      };
    }),
  );
  const immediatePreDecodeDurationMs = Math.max(
    ...measurements
      .slice(0, DEFAULT_CONCURRENCY)
      .map(({ preDecodeDurationMs }) => preDecodeDurationMs),
  );
  const queueDurationMs = Math.max(
    0,
    ...measurements
      .slice(DEFAULT_CONCURRENCY)
      .map(({ preDecodeDurationMs }) => preDecodeDurationMs - immediatePreDecodeDurationMs),
  );

  return {
    activeGenerationPeak: harness.readPeakActiveGenerations(),
    decodeDurationMs: round(
      Math.max(...measurements.map(({ decodeDurationMs }) => decodeDurationMs)),
    ),
    dimensions,
    inputBytes: input.length * copies,
    outcomeCode: measurements.every(({ outcomeCode }) => outcomeCode === "generated")
      ? "generated"
      : measurements.map(({ outcomeCode }) => outcomeCode).join(","),
    peakMemoryBytes: stopMemorySampler(),
    queueDurationMs: round(queueDurationMs),
    sampleCount: copies,
    totalDurationMs: round(performance.now() - batchStartedAt),
  };
};

const measureWorkload = async ({ copies, dimensions, file, harness, mimeType, name }) => {
  const input = await readFile(file);

  await mapSequentially(Array.from({ length: WARM_UP_EXECUTIONS }), () =>
    runBatch({ copies, dimensions, harness, input, mimeType }),
  );
  const measurements = await mapSequentially(
    Array.from({ length: RECORDED_EXECUTIONS }),
    async (_, index) => {
      const measurement = await runBatch({
        copies,
        dimensions,
        harness,
        input,
        mimeType,
      });
      assert(measurement.outcomeCode === "generated", `${name} did not generate a BlurHash`);
      assert(
        measurement.totalDurationMs < SUCCESS_THRESHOLD_MS,
        `${name} completed in ${measurement.totalDurationMs}ms, exceeding the five-second success threshold`,
      );
      assert(measurement.activeGenerationPeak <= 2, `${name} exceeded concurrency two`);
      return { execution: index + 1, ...measurement };
    },
  );

  return {
    measurements,
    name,
    recordedExecutions: RECORDED_EXECUTIONS,
    warmUpExecutions: WARM_UP_EXECUTIONS,
  };
};

const verifySizeBoundaries = async ({ fixtureDirectory, harness }) => {
  const cases = [
    {
      dimensions: { height: 24, width: 40 },
      expectedCode: "generated",
      filename: "bytes-at.jpg",
      mimeType: "image/jpeg",
      name: "bytes-at",
    },
    {
      dimensions: { height: 24, width: 40 },
      expectedCode: "input_too_large",
      filename: "bytes-over.jpg",
      mimeType: "image/jpeg",
      name: "bytes-over",
    },
    {
      dimensions: { height: 5_000, width: 8_000 },
      expectedCode: "generated",
      filename: "pixels-and-bytes-at.png",
      mimeType: "image/png",
      name: "pixels-at",
    },
    {
      dimensions: { height: 5_001, width: 8_000 },
      expectedCode: "input_too_large",
      filename: "pixels-over.png",
      mimeType: "image/png",
      name: "pixels-over",
    },
    {
      dimensions: { height: 1, width: MAX_INPUT_SIDE },
      expectedCode: "generated",
      filename: "side-at.png",
      mimeType: "image/png",
      name: "side-at",
    },
    {
      dimensions: { height: 1, width: MAX_INPUT_SIDE + 1 },
      expectedCode: "input_too_large",
      filename: "side-over.png",
      mimeType: "image/png",
      name: "side-over",
    },
  ];

  return mapSequentially(cases, async ({ dimensions, expectedCode, filename, mimeType, name }) => {
    const input = await readFile(path.join(fixtureDirectory, filename));
    const measurement = await runBatch({
      copies: 1,
      dimensions,
      harness,
      input,
      mimeType,
    });
    assert(measurement.outcomeCode === expectedCode, `${name} returned ${measurement.outcomeCode}`);
    return { name, ...measurement };
  });
};

const verifyConcurrencyBoundaries = async ({ fixtureDirectory, harness }) => {
  const input = await readFile(path.join(fixtureDirectory, "bytes-at.jpg"));
  const dimensions = { height: 24, width: 40 };

  return mapSequentially([2, 3], async (copies) => {
    const measurement = await runBatch({
      copies,
      dimensions,
      harness,
      input,
      mimeType: "image/jpeg",
    });
    assert(measurement.outcomeCode === "generated", `Concurrency ${copies} did not generate`);
    assert(
      measurement.activeGenerationPeak === 2,
      `Concurrency ${copies} observed ${measurement.activeGenerationPeak} active generations`,
    );
    return { name: copies === 2 ? "concurrency-at" : "concurrency-over", ...measurement };
  });
};

const measure = async (outputFile) => {
  const environment = await readControlledEnvironment();
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-limits-"));
  const harnesses = [];

  try {
    await runCommand(process.execPath, [scriptPath, "--generate-fixtures", fixtureDirectory]);
    const harness = await startPayloadHarness({
      directory: fixtureDirectory,
      name: "default-limits",
    });
    harnesses.push(harness);
    const timeoutHarness = await startPayloadHarness({
      directory: fixtureDirectory,
      hangMetadata: true,
      limits: { timeoutSeconds: 1 },
      name: "timeout-limit",
    });
    harnesses.push(timeoutHarness);
    const correctness = [
      ...(await verifySizeBoundaries({ fixtureDirectory, harness })),
      ...(await verifyConcurrencyBoundaries({ fixtureDirectory, harness })),
    ];
    const timeoutInput = await readFile(path.join(fixtureDirectory, "bytes-at.jpg"));
    const timeoutMeasurement = await runBatch({
      copies: 1,
      dimensions: { height: 24, width: 40 },
      harness: timeoutHarness,
      input: timeoutInput,
      mimeType: "image/jpeg",
    });
    assert(
      timeoutMeasurement.outcomeCode === "decode_timeout",
      `Timeout boundary returned ${timeoutMeasurement.outcomeCode}`,
    );
    assert(timeoutMeasurement.totalDurationMs >= 950, "Timeout settled before its boundary");
    assert(
      timeoutMeasurement.totalDurationMs < 1_500,
      "Timeout settled too far beyond its boundary",
    );
    correctness.push({
      configuredTimeoutSeconds: 1,
      name: "timeout-at-and-over",
      ...timeoutMeasurement,
    });

    const workloads = await mapSequentially(
      [
        {
          copies: 1,
          dimensions: { height: 24, width: 40 },
          file: path.join(fixtureDirectory, "bytes-at.jpg"),
          harness,
          mimeType: "image/jpeg",
          name: "compressed-byte-limit",
        },
        {
          copies: 1,
          dimensions: { height: 5_000, width: 8_000 },
          file: path.join(fixtureDirectory, "pixels-and-bytes-at.png"),
          harness,
          mimeType: "image/png",
          name: "decoded-pixel-and-byte-limit",
        },
        {
          copies: 1,
          dimensions: { height: 1, width: MAX_INPUT_SIDE },
          file: path.join(fixtureDirectory, "side-at.png"),
          harness,
          mimeType: "image/png",
          name: "side-length-limit",
        },
        {
          copies: 2,
          dimensions: { height: 5_000, width: 8_000 },
          file: path.join(fixtureDirectory, "pixels-and-bytes-at.png"),
          harness,
          mimeType: "image/png",
          name: "two-concurrent-worst-case-generations",
        },
      ],
      measureWorkload,
    );
    const concurrentWorkload = workloads.find(
      ({ name }) => name === "two-concurrent-worst-case-generations",
    );
    const concurrentPeakMemoryBytes = Math.max(
      ...concurrentWorkload.measurements.map(({ peakMemoryBytes }) => peakMemoryBytes),
    );
    const concurrentActiveGenerationPeak = Math.max(
      ...concurrentWorkload.measurements.map(({ activeGenerationPeak }) => activeGenerationPeak),
    );

    assert(
      concurrentPeakMemoryBytes < MEMORY_THRESHOLD_BYTES,
      "Two concurrent worst-case generations exceeded 1.5 GiB",
    );
    assert(
      concurrentActiveGenerationPeak <= 2,
      "Two concurrent generations exceeded the queue cap",
    );

    const evidence = {
      correctness,
      environment,
      generatedAt: new Date().toISOString(),
      limits: {
        concurrency: DEFAULT_CONCURRENCY,
        maxInputBytes: MAX_INPUT_BYTES,
        maxInputPixels: MAX_INPUT_PIXELS,
        maxInputSide: MAX_INPUT_SIDE,
        timeoutSeconds: 10,
      },
      schemaVersion: 1,
      summary: {
        concurrentActiveGenerationPeak,
        concurrentPeakMemoryBytes,
        successThresholdMs: SUCCESS_THRESHOLD_MS,
      },
      workloads,
    };
    const temporaryOutput = `${outputFile}.tmp`;
    await mkdir(path.dirname(outputFile), { recursive: true });
    await writeFile(temporaryOutput, `${JSON.stringify(evidence, undefined, 2)}\n`);
    await rename(temporaryOutput, outputFile);
    console.log(JSON.stringify(evidence.summary));
  } finally {
    try {
      await Promise.allSettled(harnesses.map(({ destroy }) => destroy()));
    } finally {
      await rm(fixtureDirectory, { force: true, recursive: true });
    }
  }
};

if (process.argv[2] === "--generate-fixtures") {
  await generateFixtures(process.argv[3]);
} else {
  await measure(process.argv[2] ?? "/artifacts/blurhash-limits.json");
}
