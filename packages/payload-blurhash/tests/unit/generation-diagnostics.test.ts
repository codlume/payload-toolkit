import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    ({ payload, testDirectory } = await startPayload({ debug: true, sharp: hostSharp }));
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
});
