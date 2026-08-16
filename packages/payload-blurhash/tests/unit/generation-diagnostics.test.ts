import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import {
  buildConfig,
  getPayload,
  type CollectionBeforeChangeHook,
  type Payload,
  type SharpDependency,
} from "payload";
import hostSharp from "sharp";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { blurHashPlugin } from "@codlume/payload-blurhash";

const fixtureDirectory = new URL(
  "../../../../apps/payload-cms/tests/fixtures/images/",
  import.meta.url,
);
const DIAGNOSTIC_FIELDS = new Set([
  "code",
  "collection",
  "durationMs",
  "event",
  "height",
  "inputBytes",
  "mimeType",
  "plugin",
  "stage",
  "width",
]);
let jpegDecoderAvailable = true;
const controlledSharp = ((input, options) => hostSharp(input, options)) satisfies SharpDependency;
Object.defineProperty(controlledSharp, "format", {
  get: () =>
    jpegDecoderAvailable
      ? hostSharp.format
      : { ...hostSharp.format, jpeg: { input: { buffer: false } } },
});

const failBlurHashGeneration: CollectionBeforeChangeHook = ({ context, data, req }) => {
  if (context.failBlurHashGeneration && req.file) {
    req.file.data = Buffer.from("private invalid image bytes");
  }

  return data;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const diagnosticEntries = (calls: readonly (readonly unknown[])[]) =>
  calls.flatMap(([entry]) => (isRecord(entry) && entry.plugin === "blurhash" ? [entry] : []));

const startPayload = async ({ debug, sharp }: { debug: boolean; sharp: SharpDependency }) => {
  const testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-diagnostics-unit-"));
  const config = await buildConfig({
    collections: [
      {
        fields: [{ name: "metadata", type: "json" }],
        hooks: { beforeChange: [failBlurHashGeneration] },
        slug: "media",
        upload: { staticDir: path.join(testDirectory, "media") },
      },
    ],
    db: sqliteAdapter({ client: { url: `file:${path.join(testDirectory, "payload.db")}` } }),
    plugins: [blurHashPlugin({ collections: ["media"], debug })],
    secret: "diagnostics-unit-test-secret",
    sharp,
    telemetry: false,
  });
  const payload = await getPayload({ config, key: testDirectory });

  return { payload, testDirectory };
};

const upload = (
  payload: Payload,
  input: Buffer,
  mimeType: string,
  name: string,
  context: Record<string, unknown>,
) =>
  payload.create({
    collection: "media",
    context,
    data: {},
    file: { data: input, mimetype: mimeType, name, size: input.length },
  });

describe("BlurHash generation diagnostics", () => {
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    ({ payload, testDirectory } = await startPayload({ debug: true, sharp: controlledSharp }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("emits generated lifecycle events through the host logger", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const media = await upload(payload, input, "image/jpeg", "generated.jpg", {});
    const entries = diagnosticEntries(debug.mock.calls);

    expect({
      events: entries.map((entry) => entry.event),
      generated: typeof media.blurHash,
      warnings: diagnosticEntries(warn.mock.calls),
    }).toEqual({
      events: ["generation_started", "generation_generated"],
      generated: "string",
      warnings: [],
    });
  });

  test("emits an unsupported input skip only when debug diagnostics are enabled", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const mimeType = `text/${"x".repeat(200)}`;
    const input = Buffer.from("unsupported");
    await upload(payload, input, mimeType, "unsupported.txt", {});
    const entries = diagnosticEntries(debug.mock.calls);

    expect({
      events: entries.map((entry) => ({ code: entry.code, event: entry.event })),
      loggedMimeTypes: entries.map((entry) => entry.mimeType),
      warnings: diagnosticEntries(warn.mock.calls),
    }).toEqual({
      events: [
        { code: undefined, event: "generation_started" },
        { code: "not_eligible", event: "generation_skipped" },
      ],
      loggedMimeTypes: [mimeType.slice(0, 128), mimeType.slice(0, 128)],
      warnings: [],
    });
  });

  test("emits an animated input skip only when debug diagnostics are enabled", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await readFile(new URL("png-apng-two-frame.png", fixtureDirectory));
    await upload(payload, input, "image/png", "animated.png", {});

    expect({
      events: diagnosticEntries(debug.mock.calls).map((entry) => ({
        code: entry.code,
        event: entry.event,
      })),
      warnings: diagnosticEntries(warn.mock.calls),
    }).toEqual({
      events: [
        { code: undefined, event: "generation_started" },
        { code: "animated_input", event: "generation_skipped" },
      ],
      warnings: [],
    });
  });

  test("warns for an actionable generation failure", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const media = await upload(payload, input, "image/jpeg", "failed.jpg", {
      failBlurHashGeneration: true,
    });

    expect({
      debugEvents: diagnosticEntries(debug.mock.calls).map((entry) => entry.event),
      outcome: media.blurHash,
      warnings: diagnosticEntries(warn.mock.calls).map((entry) => ({
        code: entry.code,
        event: entry.event,
      })),
    }).toEqual({
      debugEvents: ["generation_started"],
      outcome: null,
      warnings: [{ code: "malformed_container", event: "generation_failed" }],
    });
  });

  test("warns once when a format decoder is unavailable", async () => {
    jpegDecoderAvailable = false;

    try {
      const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
      const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
      await upload(payload, input, "image/jpeg", "first.jpg", {});
      await upload(payload, input, "image/jpeg", "second.jpg", {});

      expect(
        diagnosticEntries(warn.mock.calls).map((entry) => ({
          code: entry.code,
          event: entry.event,
        })),
      ).toEqual([{ code: "decoder_unavailable", event: "generation_failed" }]);
    } finally {
      jpegDecoderAvailable = true;
    }
  });

  test("omits private upload data from complete logger calls", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    const privatePath = path.join(testDirectory, "private-source.jpg");
    await writeFile(privatePath, input);
    const media = await payload.create({
      collection: "media",
      data: { metadata: { private: "private metadata blob" } },
      file: {
        data: input,
        mimetype: "image/jpeg",
        name: "private-filename.jpg",
        size: input.length,
        tempFilePath: privatePath,
      },
    });
    const calls = [...debug.mock.calls, ...warn.mock.calls].filter(([entry]) =>
      isRecord(entry) ? entry.plugin === "blurhash" : false,
    );
    const serializedCalls = JSON.stringify(calls);
    const privateValues = [
      media.blurHash,
      input.toString("base64"),
      "private-filename.jpg",
      privatePath,
      "private metadata blob",
    ].filter((value): value is string => typeof value === "string");

    expect(privateValues.filter((value) => serializedCalls.includes(value))).toEqual([]);
  });

  test("emits one structured allowlisted object per logger call", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));
    await upload(payload, input, "image/jpeg", "structured.jpg", {});
    const calls = [...debug.mock.calls, ...warn.mock.calls].filter(([entry]) =>
      isRecord(entry) ? entry.plugin === "blurhash" : false,
    );

    expect(
      calls.every(
        (call) =>
          call.length === 1 &&
          isRecord(call[0]) &&
          Object.keys(call[0]).every((key) => DIAGNOSTIC_FIELDS.has(key)),
      ),
    ).toBe(true);
  });
});
