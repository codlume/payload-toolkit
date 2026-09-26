import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, type Payload } from "payload";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";

describe("oriented upload dimensions", () => {
  let payload: Payload;
  let testDirectory: string;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-dimensions-"));
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

  test.each([1, 3, 6, 8])(
    "orientation %s stores the displayed image dimensions",
    async (orientation) => {
      const data = await sharp({
        create: { background: "#e87436", channels: 3, height: 40, width: 80 },
      })
        .withMetadata({ orientation })
        .jpeg()
        .toBuffer();
      const displayed = await sharp(data).rotate().toBuffer({ resolveWithObject: true });
      const created = await payload.create({
        collection: "media",
        data: {},
        file: {
          data,
          mimetype: "image/jpeg",
          name: `orientation-${orientation}.jpg`,
          size: data.length,
        },
      });
      const stored = await payload.findByID({ collection: "media", id: created.id });

      expect(stored.blurHash).toHaveLength(28);
      expect({ height: stored.height, width: stored.width }).toEqual({
        height: displayed.info.height,
        width: displayed.info.width,
      });
    },
  );
});
