import path from "node:path";

import { createAppConfig } from "./app-config.ts";

const stateDirectory = path.resolve(process.env.PAYLOAD_STATE_DIRECTORY ?? ".payload");
const configuredMode = process.env.PAYLOAD_APP_MODE ?? "enabled-in-memory";

if (
  configuredMode !== "disabled-in-memory" &&
  configuredMode !== "enabled-in-memory" &&
  configuredMode !== "enabled-temporary-file"
) {
  throw new Error(`Invalid PAYLOAD_APP_MODE: ${configuredMode}`);
}

export default createAppConfig({
  blurHash: {
    alphaBackground: "default",
    debug: false,
  },
  databaseURL: `file:${path.join(stateDirectory, "payload.db")}`,
  generatedTypesFile: path.resolve("src/payload-types.generated.ts"),
  mediaBeforeChangeHooks: [],
  mode: configuredMode,
  storage: {
    bucket: process.env.PAYLOAD_S3_BUCKET ?? "payload-blurhash",
    config: {
      credentials: {
        accessKeyId: process.env.PAYLOAD_S3_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.PAYLOAD_S3_SECRET_ACCESS_KEY ?? "test",
      },
      endpoint: process.env.PAYLOAD_S3_ENDPOINT ?? "http://127.0.0.1:4566",
      forcePathStyle: process.env.PAYLOAD_S3_FORCE_PATH_STYLE !== "false",
      region: process.env.PAYLOAD_S3_REGION ?? "us-east-1",
    },
    prefix: process.env.PAYLOAD_S3_PREFIX ?? "development",
  },
  uploadDirectory: path.join(stateDirectory, "media"),
});
