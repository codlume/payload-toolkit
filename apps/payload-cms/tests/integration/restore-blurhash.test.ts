import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createLocalReq, getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { createJpegFixture } from "./image-fixtures.ts";

describe("restored upload BlurHash", () => {
  let payload: Payload;
  let testDirectory: string;
  let hostRestoreOperations = 0;

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-restore-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: "default", debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedFiles: {
        importMap: path.join(testDirectory, "importMap.js"),
        types: path.join(testDirectory, "payload-types.generated.ts"),
      },
      mediaBeforeChangeHooks: [
        async ({ context, data, req }) => {
          if (context.failRestore) {
            throw new Error("Intentional restore failure");
          }

          if (typeof context.nestedMediaID === "number" && !context.nestedWriteDone) {
            context.nestedWriteDone = true;
            await req.payload.update({
              collection: "media",
              data: { blurHash: "nested-caller-supplied" },
              id: context.nestedMediaID,
              req,
            });
          }

          return data;
        },
      ],
      mode: "enabled-in-memory",
      storage: false,
      uploadDirectory: path.join(testDirectory, "media"),
    });
    const media = config.collections.find((collection) => collection.slug === "media");

    if (!media) {
      throw new Error("Expected the configured media collection.");
    }

    media.hooks.beforeOperation.unshift(({ args, operation }) => {
      if (operation === "restoreVersion") {
        hostRestoreOperations += 1;
      }

      return args;
    });
    payload = await getPayload({ config });
  });

  afterAll(async () => {
    await payload.destroy();
    await rm(testDirectory, { force: true, recursive: true });
  });

  test.each(["generated", "missing"])(
    "restores a version with a %s BlurHash",
    async (hashState) => {
      const firstFile =
        hashState === "generated"
          ? {
              data: await createJpegFixture({ b: 0, g: 0, r: 220 }),
              mimetype: "image/jpeg",
              name: "red.jpg",
            }
          : { data: Buffer.from("plain text"), mimetype: "text/plain", name: "text.txt" };
      const created = await payload.create({
        collection: "media",
        data: {},
        file: { ...firstFile, size: firstFile.data.length },
      });
      const {
        docs: [version],
      } = await payload.findVersions({
        collection: "media",
        where: { parent: { equals: created.id } },
      });

      if (!version) {
        throw new Error("Expected an upload version to restore.");
      }

      const replacement = await createJpegFixture({ b: 220, g: 0, r: 0 });
      const current = await payload.update({
        collection: "media",
        data: {},
        file: {
          data: replacement,
          mimetype: "image/jpeg",
          name: "blue.jpg",
          size: replacement.length,
        },
        id: created.id,
      });

      expect(current.blurHash).toHaveLength(28);
      expect(current.blurHash).not.toBe(created.blurHash);

      const nestedTarget = await payload.create({
        collection: "media",
        data: {},
        file: {
          data: replacement,
          mimetype: "image/jpeg",
          name: "nested.jpg",
          size: replacement.length,
        },
      });
      const req = await createLocalReq({ context: { nestedMediaID: nestedTarget.id } }, payload);
      await payload.restoreVersion({ collection: "media", id: version.id, req });
      const restored = await payload.findByID({ collection: "media", id: created.id });

      expect({ blurHash: restored.blurHash, filename: restored.filename }).toEqual({
        blurHash: created.blurHash,
        filename: created.filename,
      });

      await payload.update({
        collection: "media",
        data: { blurHash: "caller-supplied-after-restore" },
        id: created.id,
        req,
      });
      const edited = await payload.findByID({ collection: "media", id: created.id });

      expect(edited.blurHash).toBe(created.blurHash);

      const nested = await payload.findByID({ collection: "media", id: nestedTarget.id });
      expect(nested.blurHash).toBe(nestedTarget.blurHash);
      expect(req.context.nestedWriteDone).toBe(true);
      expect(hostRestoreOperations).toBeGreaterThan(0);

      req.context.failRestore = true;
      await expect(
        payload.restoreVersion({ collection: "media", id: version.id, req }),
      ).rejects.toThrow("Intentional restore failure");
      delete req.context.failRestore;
      await payload.update({
        collection: "media",
        data: { blurHash: "caller-supplied-after-failure" },
        id: created.id,
        req,
      });
      const afterFailure = await payload.findByID({ collection: "media", id: created.id });

      expect(afterFailure.blurHash).toBe(created.blurHash);
    },
  );
});
