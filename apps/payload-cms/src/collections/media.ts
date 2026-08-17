import type { CollectionBeforeChangeHook, CollectionConfig } from "payload";

export const createMediaCollection = (
  uploadDirectory: string,
  beforeChangeHooks: CollectionBeforeChangeHook[],
): CollectionConfig => ({
  access: {
    read: () => true,
  },
  fields: [],
  hooks: { beforeChange: beforeChangeHooks },
  slug: "media",
  upload: {
    staticDir: uploadDirectory,
  },
});
