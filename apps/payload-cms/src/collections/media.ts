import type { CollectionConfig } from "payload";

export const createMediaCollection = (uploadDirectory: string): CollectionConfig => ({
  access: {
    read: () => true,
  },
  fields: [],
  slug: "media",
  upload: {
    staticDir: uploadDirectory,
  },
});
