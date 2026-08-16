import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type CollectionBeforeChangeHook } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Users } from "./collections/users.ts";

type AppConfigOptions = {
  blurHash: {
    alphaBackground: "default" | NonNullable<BlurHashPluginOptions["alphaBackground"]>;
    debug: boolean;
    enabled: boolean;
  };
  databaseURL: string;
  generatedTypesFile: string;
  mediaBeforeChangeHooks: CollectionBeforeChangeHook[];
  uploadDirectory: string;
};

export const createAppConfig = ({
  blurHash,
  databaseURL,
  generatedTypesFile,
  mediaBeforeChangeHooks,
  uploadDirectory,
}: AppConfigOptions) =>
  buildConfig({
    collections: [createMediaCollection(uploadDirectory, mediaBeforeChangeHooks), Users],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    plugins: [
      blurHashPlugin({
        collections: ["media"],
        debug: blurHash.debug,
        enabled: blurHash.enabled,
        ...(blurHash.alphaBackground === "default"
          ? {}
          : { alphaBackground: blurHash.alphaBackground }),
      }),
    ],
    secret: "payload-blurhash-development-secret",
    sharp,
    telemetry: false,
    typescript: {
      outputFile: generatedTypesFile,
    },
  });
