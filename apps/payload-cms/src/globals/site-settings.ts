import type { GlobalConfig } from "payload";

export const SiteSettings = {
  fields: [{ name: "siteName", type: "text" }],
  slug: "site-settings",
} satisfies GlobalConfig;
