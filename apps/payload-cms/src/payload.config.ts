import { mkdirSync } from "node:fs";
import path from "node:path";

import { createAppConfig } from "./app-config.ts";

const stateDirectory = path.resolve(process.env.PAYLOAD_STATE_DIRECTORY ?? ".payload");
// The state directory is gitignored, so fresh checkouts lack it and libsql
// fails with SQLITE_CANTOPEN rather than creating parent directories.
mkdirSync(stateDirectory, { recursive: true });
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
  generatedFiles: {
    importMap: path.resolve(
      process.env.PAYLOAD_IMPORT_MAP_FILE ?? "src/app/(payload)/admin/importMap.js",
    ),
    types: path.resolve(process.env.PAYLOAD_TS_OUTPUT_PATH ?? "src/payload-types.generated.ts"),
  },
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
