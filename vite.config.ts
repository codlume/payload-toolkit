import { defineConfig } from "vite-plus";

export default defineConfig({
  fmt: {
    ignorePatterns: [
      ".vite-plus",
      "build",
      "coverage",
      "dist",
      "generated",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/*.generated.*",
      "**/generated/**",
    ],
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: [
      ".vite-plus",
      "build",
      "coverage",
      "dist",
      "generated",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/*.generated.*",
      "**/generated/**",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
});
