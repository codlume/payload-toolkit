import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    clean: true,
    dts: true,
    entry: ["src/index.ts", "src/core.ts", "src/react.ts", "src/client.tsx"],
    unbundle: true,
    root: "src",
    platform: "node",
  },
});
