import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { readImageFixture } from "./image-fixtures.ts";

describe("configured alpha background", () => {
  let payload: Payload;
  let testDirectory: string;

  const upload = async (fixtureName: string) => {
    const data = await readImageFixture(fixtureName);

    return payload.create({
      collection: "media",
      data: {},
      file: {
        data,
        mimetype: "image/png",
        name: fixtureName,
        size: data.length,
      },
    });
  };

  beforeAll(async () => {
    testDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-alpha-background-"));
    const config = await createAppConfig({
      blurHash: { alphaBackground: { b: 0, g: 0, r: 0 }, debug: false },
      databaseURL: `file:${path.join(testDirectory, "payload.db")}`,
      generatedTypesFile: path.join(testDirectory, "payload-types.generated.ts"),
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

  test("alpha uses the configured opaque background", async () => {
    const alpha = await upload("png-alpha-hidden-red.png");
    const blackReference = await upload("png-alpha-black-reference.png");

    expect(alpha.blurHash).toBe(blackReference.blurHash);
  });
});
