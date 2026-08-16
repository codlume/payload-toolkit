import path from "node:path";

import { createAppConfig } from "./app-config.ts";

const stateDirectory = path.resolve(process.env.PAYLOAD_STATE_DIRECTORY ?? ".payload");

export default createAppConfig({
  databaseURL: `file:${path.join(stateDirectory, "payload.db")}`,
  uploadDirectory: path.join(stateDirectory, "media"),
});
