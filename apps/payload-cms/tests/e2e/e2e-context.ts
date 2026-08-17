import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { getPayload } from "payload";

import { createAppConfig } from "../../src/app-config.ts";
import { createS3TestStorage } from "../s3-test-context.ts";

export const adminUser = {
  email: "preview@example.com",
  password: "preview-test-password",
};

const getStateDirectory = (mode: "disabled" | "enabled") => {
  const root = process.env.PAYLOAD_E2E_STATE_DIRECTORY;

  if (!root) {
    throw new Error("PAYLOAD_E2E_STATE_DIRECTORY is required for Admin end-to-end tests.");
  }

  return path.join(root, mode);
};

export const createE2EPayload = async (mode: "disabled" | "enabled") => {
  const stateDirectory = getStateDirectory(mode);
  const s3Prefix = process.env.PAYLOAD_E2E_S3_PREFIX;

  if (!s3Prefix) {
    throw new Error("PAYLOAD_E2E_S3_PREFIX is required for Admin end-to-end tests.");
  }

  await mkdir(stateDirectory, { recursive: true });

  const config = await createAppConfig({
    blurHash: {
      alphaBackground: "default",
      debug: false,
    },
    databaseURL: `file:${path.join(stateDirectory, "payload.db")}`,
    generatedTypesFile: path.join(stateDirectory, "payload-types.generated.ts"),
    mediaBeforeChangeHooks: [],
    mode: mode === "enabled" ? "enabled-in-memory" : "disabled-in-memory",
    storage: createS3TestStorage(`${s3Prefix}/${mode}`),
    uploadDirectory: path.join(stateDirectory, "media"),
  });

  return getPayload({ config });
};

export const seedAdminUser = (payload: Awaited<ReturnType<typeof createE2EPayload>>) =>
  payload.create({
    collection: "users",
    data: adminUser,
  });

const createUpload = async (
  payload: Awaited<ReturnType<typeof createE2EPayload>>,
  name: string,
  mimetype: string,
  data: Buffer,
) =>
  payload.create({
    collection: "media",
    data: {},
    file: { data, mimetype, name, size: data.length },
  });

export const seedPreviewDocuments = async (
  payload: Awaited<ReturnType<typeof createE2EPayload>>,
) => {
  const validInput = await readFile(
    new URL("../fixtures/images/jpeg-baseline.jpg", import.meta.url),
  );
  const valid = await createUpload(payload, "valid.jpg", "image/jpeg", validInput);
  const missing = await createUpload(
    payload,
    "unsupported.txt",
    "text/plain",
    Buffer.from("not an image"),
  );
  const invalid = await createUpload(
    payload,
    "invalid.txt",
    "text/plain",
    Buffer.from("invalid stored value fixture"),
  );

  await payload.db.updateOne({
    collection: "media",
    data: { blurHash: "not-a-blurhash" },
    id: invalid.id,
  });

  return {
    invalidID: invalid.id,
    missingID: missing.id,
    validID: valid.id,
  };
};
