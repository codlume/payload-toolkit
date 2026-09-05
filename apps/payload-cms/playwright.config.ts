import path from "node:path";

import { defineConfig, devices } from "@playwright/test";

const requireEnvironment = (name: string) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing ${name}; run the package test:e2e script.`);
  }

  return value;
};

const stateDirectory = requireEnvironment("PAYLOAD_E2E_STATE_DIRECTORY");
const enabledDistDirectory = requireEnvironment("PAYLOAD_E2E_ENABLED_DIST_DIRECTORY");
const disabledDistDirectory = requireEnvironment("PAYLOAD_E2E_DISABLED_DIST_DIRECTORY");
const enabledTsconfigPath = requireEnvironment("PAYLOAD_E2E_ENABLED_TSCONFIG_PATH");
const disabledTsconfigPath = requireEnvironment("PAYLOAD_E2E_DISABLED_TSCONFIG_PATH");
const s3Prefix = requireEnvironment("PAYLOAD_E2E_S3_PREFIX");
const enabledPort = Number(requireEnvironment("PAYLOAD_E2E_ENABLED_PORT"));
const disabledPort = Number(requireEnvironment("PAYLOAD_E2E_DISABLED_PORT"));

export default defineConfig({
  forbidOnly: Boolean(process.env.CI),
  outputDir: path.join(stateDirectory, "playwright-output"),
  projects: [
    {
      name: "enabled",
      testMatch: ["preview.e2e.test.ts", "live-preview.e2e.test.ts"],
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${enabledPort}`,
      },
    },
    {
      name: "disabled",
      testMatch: "disabled-preview.e2e.test.ts",
      use: {
        ...devices["Desktop Chrome"],
        baseURL: `http://127.0.0.1:${disabledPort}`,
      },
    },
  ],
  reporter: "line",
  retries: process.env.CI ? 1 : 0,
  testDir: "./tests/e2e",
  use: {
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `pnpm exec next dev --hostname 127.0.0.1 --port ${enabledPort}`,
      env: {
        PAYLOAD_APP_MODE: "enabled-in-memory",
        PAYLOAD_LIVE_PREVIEW_DEBUG: "true",
        PAYLOAD_PUBLIC_SERVER_URL: `http://127.0.0.1:${enabledPort}`,
        PAYLOAD_NEXT_DIST_DIRECTORY: enabledDistDirectory,
        PAYLOAD_NEXT_TSCONFIG_PATH: enabledTsconfigPath,
        PAYLOAD_S3_PREFIX: `${s3Prefix}/enabled`,
        PAYLOAD_STATE_DIRECTORY: path.join(stateDirectory, "enabled"),
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://127.0.0.1:${enabledPort}/admin`,
    },
    {
      command: `pnpm exec next dev --hostname 127.0.0.1 --port ${disabledPort}`,
      env: {
        PAYLOAD_APP_MODE: "disabled-in-memory",
        PAYLOAD_NEXT_DIST_DIRECTORY: disabledDistDirectory,
        PAYLOAD_NEXT_TSCONFIG_PATH: disabledTsconfigPath,
        PAYLOAD_S3_PREFIX: `${s3Prefix}/disabled`,
        PAYLOAD_STATE_DIRECTORY: path.join(stateDirectory, "disabled"),
      },
      reuseExistingServer: false,
      timeout: 120_000,
      url: `http://127.0.0.1:${disabledPort}/admin`,
    },
  ],
  workers: 1,
});
