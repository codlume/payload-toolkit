import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { s3Storage, type S3StorageOptions } from "@payloadcms/storage-s3";
import path from "node:path";
import { buildConfig, type CollectionBeforeChangeHook } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Users } from "./collections/users.ts";

type AppStorageOptions = {
  bucket: string;
  config: S3StorageOptions["config"];
  prefix: string;
};

type AppConfigOptions = {
  blurHash: {
    alphaBackground: "default" | NonNullable<BlurHashPluginOptions["alphaBackground"]>;
    debug: boolean;
  };
  databaseURL: string;
  generatedTypesFile: string;
  mediaBeforeChangeHooks: CollectionBeforeChangeHook[];
  mode: "disabled-in-memory" | "enabled-in-memory" | "enabled-temporary-file";
  storage: AppStorageOptions | false;
  uploadDirectory: string;
};

export const createAppConfig = ({
  blurHash,
  databaseURL,
  generatedTypesFile,
  mediaBeforeChangeHooks,
  mode,
  storage,
  uploadDirectory,
}: AppConfigOptions) =>
  buildConfig({
    collections: [createMediaCollection(uploadDirectory, mediaBeforeChangeHooks), Users],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    plugins: [
      blurHashPlugin({
        collections: ["media"],
        debug: blurHash.debug,
        enabled: mode !== "disabled-in-memory",
        ...(blurHash.alphaBackground === "default"
          ? {}
          : { alphaBackground: blurHash.alphaBackground }),
      }),
      ...(storage === false
        ? []
        : [
            s3Storage({
              bucket: storage.bucket,
              clientUploads: true,
              collections: { media: { prefix: storage.prefix } },
              config: storage.config,
            }),
          ]),
    ],
    secret: "payload-blurhash-development-secret",
    sharp,
    telemetry: false,
    upload:
      mode === "enabled-temporary-file"
        ? {
            tempFileDir: path.join(uploadDirectory, ".tmp"),
            useTempFiles: true,
          }
        : {},
    typescript: {
      outputFile: generatedTypesFile,
    },
  });
