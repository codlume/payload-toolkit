import type { CollectionSlug, Plugin, TextField } from "payload";

import { generateBlurHash } from "./generate-blur-hash.ts";

export type BlurHashPluginOptions = {
  collections: CollectionSlug[];
};

export const blurHashPlugin = ({ collections }: BlurHashPluginOptions): Plugin => {
  const blurHashField = {
    localized: false,
    name: "blurHash",
    required: false,
    hooks: {
      beforeChange: [generateBlurHash],
    },
    type: "text",
    virtual: false,
  } satisfies TextField;
  const configuredCollections = new Set(collections);

  return (config) => {
    if (!config.collections) {
      return config;
    }

    return {
      ...config,
      collections: config.collections.map((collection) =>
        configuredCollections.has(collection.slug)
          ? {
              ...collection,
              fields: [...collection.fields, blurHashField],
            }
          : collection,
      ),
    };
  };
};
