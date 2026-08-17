import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, type CollectionBeforeChangeHook, type Payload } from "payload";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { createJpegFixture } from "./image-fixtures.ts";

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

describe("generation diagnostics", () => {
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-diagnostics-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: true },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedTypesFile: path.join(testDirectory, "payload-types.generated.ts"),
      mediaBeforeChangeHooks: [failBlurHashGeneration],
      mode: "enabled-in-memory",
      storage: false,
      uploadDirectory: path.join(testDirectory, "private-uploads"),
    });
    payload = await getPayload({ config });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test("captures generated lifecycle events", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await createJpegFixture({ b: 30, g: 90, r: 180 });
    const media = await payload.create({
      collection: "media",
      data: {},
      file: {
        data: input,
        mimetype: "image/jpeg",
        name: "generated.jpg",
        size: input.length,
      },
    });

    expect({
      events: diagnosticEntries(debug.mock.calls).map((entry) => entry.event),
      outcome: typeof media.blurHash,
      warnings: diagnosticEntries(warn.mock.calls),
    }).toEqual({
      events: ["generation_started", "generation_generated"],
      outcome: "string",
      warnings: [],
    });
  });

  test("captures an expected skip at debug level", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = Buffer.from("unsupported");
    const media = await payload.create({
      collection: "media",
      data: {},
      file: {
        data: input,
        mimetype: "text/plain",
        name: "skipped.txt",
        size: input.length,
      },
    });

    expect({
      events: diagnosticEntries(debug.mock.calls).map((entry) => ({
        code: entry.code,
        event: entry.event,
      })),
      outcome: media.blurHash,
      warnings: diagnosticEntries(warn.mock.calls),
    }).toEqual({
      events: [
        { code: undefined, event: "generation_started" },
        { code: "not_eligible", event: "generation_skipped" },
      ],
      outcome: null,
      warnings: [],
    });
  });

  test("captures an actionable failure at warning level", async () => {
    const debug = vi.spyOn(payload.logger, "debug").mockImplementation(() => undefined);
    const warn = vi.spyOn(payload.logger, "warn").mockImplementation(() => undefined);
    const input = await createJpegFixture({ b: 120, g: 60, r: 20 });
    const media = await payload.create({
      collection: "media",
      context: { failBlurHashGeneration: true },
      data: {},
      file: {
        data: input,
        mimetype: "image/jpeg",
        name: "failed.jpg",
        size: input.length,
      },
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
});
