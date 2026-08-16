import { fileURLToPath } from "node:url";

import { blurHashPlugin } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Users } from "./collections/users.ts";

type AppConfigOptions = {
  databaseURL: string;
  uploadDirectory: string;
};

const generatedTypesFile = fileURLToPath(new URL("./payload-types.generated.ts", import.meta.url));

export const createAppConfig = ({ databaseURL, uploadDirectory }: AppConfigOptions) =>
  buildConfig({
    collections: [createMediaCollection(uploadDirectory), Users],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    plugins: [blurHashPlugin({ collections: ["media"] })],
    secret: "payload-blurhash-development-secret",
    sharp,
    telemetry: false,
    typescript: {
      outputFile: generatedTypesFile,
    },
  });
