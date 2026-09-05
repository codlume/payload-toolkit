import type { Config, GlobalConfig } from "payload";
import { Pages } from "../../src/collections/pages.ts";
import { SiteSettings } from "../../src/globals/site-settings.ts";

/** Opt-in test schema. The public workspace example keeps its original globals and locales. */
export const previewTestConfig = {
  localization: {
    locales: [
      { code: "en", label: "English" },
      { code: "pl", label: "Polish" },
    ],
    defaultLocale: "en",
    fallback: false,
  } satisfies Config["localization"],
  livePreview: {
    globals: ["site-settings"],
    url: ({ data, locale, req }) => {
      if (!data.siteName) return null;
      const origin = process.env.PAYLOAD_PUBLIC_SERVER_URL ?? req.origin ?? "http://localhost:3000";
      return `${origin}/preview-global?locale=${encodeURIComponent(locale.code)}&mode=${data.previewMode === "client" ? "client" : "server"}`;
    },
  } satisfies NonNullable<Config["admin"]>["livePreview"],
  global: {
    ...SiteSettings,
    access: { read: ({ req }) => Boolean(req.user), update: ({ req }) => Boolean(req.user) },
    fields: [
      { name: "siteName", type: "text", localized: true },
      {
        name: "previewMode",
        type: "select",
        options: ["server", "client"],
        defaultValue: "server",
      },
      ...Pages.fields.flatMap((field) =>
        field.type === "blocks" && field.name === "layout" ? [{ ...field, localized: true }] : [],
      ),
    ],
  } satisfies GlobalConfig,
};
