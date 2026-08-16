import { fileURLToPath } from "node:url";

import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type CollectionBeforeChangeHook } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Users } from "./collections/users.ts";

type AppConfigOptions = {
  blurHash: Required<Pick<BlurHashPluginOptions, "alphaBackground" | "enabled">>;
  databaseURL: string;
  mediaBeforeChangeHooks: CollectionBeforeChangeHook[];
  uploadDirectory: string;
};

const generatedTypesFile = fileURLToPath(new URL("./payload-types.generated.ts", import.meta.url));

export const createAppConfig = ({
  blurHash,
  databaseURL,
  mediaBeforeChangeHooks,
  uploadDirectory,
}: AppConfigOptions) =>
  buildConfig({
    collections: [createMediaCollection(uploadDirectory, mediaBeforeChangeHooks), Users],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    plugins: [blurHashPlugin({ collections: ["media"], ...blurHash })],
    secret: "payload-blurhash-development-secret",
    sharp,
    telemetry: false,
    typescript: {
      outputFile: generatedTypesFile,
    },
  });
