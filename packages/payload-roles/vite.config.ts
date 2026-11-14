import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/client.ts"],
    // The server entry imports client components by package specifier so Next keeps them client-side.
    deps: { neverBundle: ["@codlume/payload-roles/client"] },
    platform: "node",
  },
});
