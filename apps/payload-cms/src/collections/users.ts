import type { CollectionConfig } from "payload";

export const Users: CollectionConfig = {
  admin: {
    useAsTitle: "name",
  },
  auth: true,
  fields: [
    {
      name: "name",
      required: true,
      type: "text",
    },
  ],
  slug: "users",
};
