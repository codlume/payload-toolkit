import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: [
    {
      clean: true,
      dts: true,
      entry: "src/index.ts",
      platform: "node",
    },
    {
      banner: { js: '"use client";' },
      clean: false,
      dts: true,
      entry: "src/client.ts",
      platform: "node",
    },
  ],
});
