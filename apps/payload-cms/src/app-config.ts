import { activityPlugin } from "@codlume/payload-activity";
import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { livePreviewPlugin } from "@codlume/payload-live-preview";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { s3Storage, type S3StorageOptions } from "@payloadcms/storage-s3";
import path from "node:path";
import { buildConfig, type CollectionBeforeChangeHook } from "payload";
import sharp from "sharp";

import { createMediaCollection } from "./collections/media.ts";
import { Pages } from "./collections/pages.ts";
import { Users } from "./collections/users.ts";
import { SiteSettings } from "./globals/site-settings.ts";
import { previewTestConfig } from "../tests/fixtures/live-preview-config.ts";

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
  generatedFiles: {
    importMap: string;
    types: string;
  };
  mediaBeforeChangeHooks: CollectionBeforeChangeHook[];
  mode: "disabled-in-memory" | "enabled-in-memory" | "enabled-temporary-file";
  previewTestContext?: boolean;
  storage: AppStorageOptions | false;
  uploadDirectory: string;
};

export const createAppConfig = ({
  blurHash,
  databaseURL,
  generatedFiles,
  mediaBeforeChangeHooks,
  mode,
  previewTestContext = false,
  storage,
  uploadDirectory,
}: AppConfigOptions) =>
  buildConfig({
    ...(previewTestContext ? { localization: previewTestConfig.localization } : {}),
    admin: {
      ...(previewTestContext ? { livePreview: previewTestConfig.livePreview } : {}),
      importMap: {
        importMapFile: generatedFiles.importMap,
      },
    },
    collections: [createMediaCollection(uploadDirectory, mediaBeforeChangeHooks), Users, Pages],
    db: sqliteAdapter({ client: { url: databaseURL } }),
    globals: [previewTestContext ? previewTestConfig.global : SiteSettings],
    plugins: [
      livePreviewPlugin({
        enabled: mode !== "disabled-in-memory",
        debug: process.env.PAYLOAD_LIVE_PREVIEW_DEBUG === "true",
      }),
      activityPlugin({ collections: ["media"], globals: ["site-settings"] }),
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
      outputFile: generatedFiles.types,
    },
  });
