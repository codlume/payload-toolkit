import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    clean: true,
    dts: true,
    entry: "src/index.ts",
    platform: "node",
  },
});
