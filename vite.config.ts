import { defineConfig } from "vite-plus";

const validationIgnorePatterns = [
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
];

export default defineConfig({
  fmt: {
    ignorePatterns: validationIgnorePatterns,
    sortPackageJson: {},
  },
  lint: {
    ignorePatterns: validationIgnorePatterns,
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
