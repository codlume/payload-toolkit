import { livePreviewPlugin } from "@codlume/payload-live-preview";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";

export default buildConfig({
  admin: {
    importMap: { importMapFile: fileURLToPath(new URL("./import-map.mjs", import.meta.url)) },
    user: "users",
  },
  collections: [
    { slug: "users", auth: true, fields: [] },
    {
      slug: "pages",
      admin: { livePreview: { url: "https://frontend.example.com/pages/example" } },
      fields: [
        {
          name: "layout",
          type: "blocks",
          blocks: [{ slug: "text", fields: [{ name: "content", type: "text" }] }],
        },
      ],
    },
  ],
  db: sqliteAdapter({
    client: { url: `file:${fileURLToPath(new URL("./payload.db", import.meta.url))}` },
  }),
  plugins: [livePreviewPlugin()],
  secret: "live-preview-packed-consumer-secret",
  telemetry: false,
});
