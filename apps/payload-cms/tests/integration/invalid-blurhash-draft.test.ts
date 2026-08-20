import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { getPayload, type Payload } from "payload";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createAppConfig } from "../../src/app-config.ts";
import { seedAdminUser } from "../e2e/e2e-context.ts";
import { setStoredBlurHash } from "../stored-blur-hash-fixture.ts";

let invalidDocumentID: number | string;
let payload: Payload;
let testDirectory: string;

beforeAll(async () => {
  testDirectory = await mkdtemp(path.join(tmpdir(), "payload-invalid-blurhash-draft-"));
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

  const invalidInput = Buffer.from("invalid stored value fixture");
  const invalid = await payload.create({
    collection: "media",
    data: {},
    file: {
      data: invalidInput,
      mimetype: "text/plain",
      name: "invalid.txt",
      size: invalidInput.length,
    },
  });
  invalidDocumentID = invalid.id;

  await setStoredBlurHash(payload, invalidDocumentID, "not-a-blurhash");
});

afterAll(async () => {
  await payload.destroy();
  await rm(testDirectory, { force: true, recursive: true });
});

test("the invalid BlurHash fixture is visible to an Admin draft read", async () => {
  const document = await payload.findByID({
    collection: "media",
    depth: 0,
    draft: true,
    id: invalidDocumentID,
  });

  expect(document.blurHash).toBe("not-a-blurhash");
});

test("the Admin user seed is safe to repeat after a Playwright retry", async () => {
  const firstUser = await seedAdminUser(payload);
  const retryUser = await seedAdminUser(payload);

  expect(retryUser.id).toBe(firstUser.id);
});
