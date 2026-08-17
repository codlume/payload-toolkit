import { defineConfig } from "vite-plus";

const validationIgnorePatterns = [
  ".vite-plus",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "pnpm-lock.yaml",
  "apps/payload-cms/src/app/(payload)/admin/importMap.js",
  "*.tsbuildinfo",
  "**/*.generated.*",
  "**/generated/**",
];

export default defineConfig({
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
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
