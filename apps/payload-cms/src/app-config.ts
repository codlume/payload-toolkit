import { fileURLToPath } from "node:url";

import { blurHashPlugin } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type CollectionBeforeChangeHook } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Users } from "./collections/users.ts";

type AppConfigOptions = {
  blurHashEnabled: boolean;
  databaseURL: string;
  mediaBeforeChangeHooks: CollectionBeforeChangeHook[];
  uploadDirectory: string;
};

const generatedTypesFile = fileURLToPath(new URL("./payload-types.generated.ts", import.meta.url));

export const createAppConfig = ({
  blurHashEnabled,
  databaseURL,
  mediaBeforeChangeHooks,
  uploadDirectory,
}: AppConfigOptions) =>
  buildConfig({
    collections: [createMediaCollection(uploadDirectory, mediaBeforeChangeHooks), Users],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    plugins: [blurHashPlugin({ collections: ["media"], enabled: blurHashEnabled })],
    secret: "payload-blurhash-development-secret",
    sharp,
    telemetry: false,
    typescript: {
      outputFile: generatedTypesFile,
    },
  });
