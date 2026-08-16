import path from "node:path";

import { createAppConfig } from "./app-config.ts";

const stateDirectory = path.resolve(process.env.PAYLOAD_STATE_DIRECTORY ?? ".payload");

export default createAppConfig({
  blurHashEnabled: true,
  databaseURL: `file:${path.join(stateDirectory, "payload.db")}`,
  mediaBeforeChangeHooks: [],
  uploadDirectory: path.join(stateDirectory, "media"),
});
