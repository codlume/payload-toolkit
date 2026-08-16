import path from "node:path";

import { createAppConfig } from "./app-config.ts";

const stateDirectory = path.resolve(process.env.PAYLOAD_STATE_DIRECTORY ?? ".payload");

export default createAppConfig({
  blurHash: {
    alphaBackground: "default",
    debug: false,
    enabled: process.env.PAYLOAD_BLURHASH_ENABLED !== "false",
  },
  databaseURL: `file:${path.join(stateDirectory, "payload.db")}`,
  generatedTypesFile: path.resolve("src/payload-types.generated.ts"),
  mediaBeforeChangeHooks: [],
  uploadDirectory: path.join(stateDirectory, "media"),
});
