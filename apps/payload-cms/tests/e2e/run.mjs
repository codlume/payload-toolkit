import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { S3Client } from "@aws-sdk/client-s3";

import { deleteOwnedS3Prefix } from "../delete-owned-s3-prefix.mjs";

const appDirectory = fileURLToPath(new URL("../..", import.meta.url));
const stateDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-e2e-"));
const runID = path.basename(stateDirectory);
const s3Prefix = `tests/${runID}/e2e`;
const enabledDistDirectory = `.next-e2e-${runID}-enabled`;
const disabledDistDirectory = `.next-e2e-${runID}-disabled`;
const enabledTsconfigPath = `tsconfig-e2e-${runID}-enabled.json`;
const disabledTsconfigPath = `tsconfig-e2e-${runID}-disabled.json`;
let interruptedSignal;
let testProcess;

const handleSignal = (signal) => {
  interruptedSignal ??= signal;
  testProcess?.kill(signal);
};
const handleInterrupt = () => handleSignal("SIGINT");
const handleTerminate = () => handleSignal("SIGTERM");

process.once("SIGINT", handleInterrupt);
process.once("SIGTERM", handleTerminate);

const findAvailablePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve an end-to-end test port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });

const removeOwnedPath = async (target, parent, prefix) => {
  const resolvedTarget = path.resolve(target);

  if (
    path.dirname(resolvedTarget) !== path.resolve(parent) ||
    !path.basename(resolvedTarget).startsWith(prefix)
  ) {
    throw new Error(`Refusing to remove unowned test directory: ${resolvedTarget}`);
  }

  await rm(resolvedTarget, { force: true, recursive: true });
};

const removeOwnedS3Objects = async (prefix) => {
  const client = new S3Client({
    credentials: {
      accessKeyId: process.env.PAYLOAD_S3_ACCESS_KEY_ID ?? "test",
      secretAccessKey: process.env.PAYLOAD_S3_SECRET_ACCESS_KEY ?? "test",
    },
    endpoint: process.env.PAYLOAD_S3_ENDPOINT ?? "http://127.0.0.1:4566",
    forcePathStyle: process.env.PAYLOAD_S3_FORCE_PATH_STYLE !== "false",
    region: process.env.PAYLOAD_S3_REGION ?? "us-east-1",
  });
  const bucket = process.env.PAYLOAD_S3_BUCKET ?? "payload-blurhash";
  await deleteOwnedS3Prefix({ bucket, client, prefix });
};

let exitCode = 1;

try {
  await Promise.all([
    mkdir(path.join(stateDirectory, "disabled")),
    mkdir(path.join(stateDirectory, "enabled")),
    copyFile(
      path.join(appDirectory, "tsconfig.json"),
      path.join(appDirectory, disabledTsconfigPath),
    ),
    copyFile(
      path.join(appDirectory, "tsconfig.json"),
      path.join(appDirectory, enabledTsconfigPath),
    ),
  ]);

  const [enabledPort, disabledPort] = await Promise.all([findAvailablePort(), findAvailablePort()]);

  exitCode = await new Promise((resolve, reject) => {
    testProcess = spawn(
      "pnpm",
      ["exec", "playwright", "test", "--config", "playwright.config.ts", ...process.argv.slice(2)],
      {
        cwd: appDirectory,
        env: {
          ...process.env,
          PAYLOAD_E2E_DISABLED_DIST_DIRECTORY: disabledDistDirectory,
          PAYLOAD_E2E_DISABLED_PORT: String(disabledPort),
          PAYLOAD_E2E_DISABLED_TSCONFIG_PATH: disabledTsconfigPath,
          PAYLOAD_E2E_ENABLED_DIST_DIRECTORY: enabledDistDirectory,
          PAYLOAD_E2E_ENABLED_PORT: String(enabledPort),
          PAYLOAD_E2E_S3_PREFIX: s3Prefix,
          PAYLOAD_E2E_ENABLED_TSCONFIG_PATH: enabledTsconfigPath,
          PAYLOAD_E2E_STATE_DIRECTORY: stateDirectory,
        },
        stdio: "inherit",
      },
    );

    testProcess.once("error", reject);
    testProcess.once("exit", (code) => resolve(code ?? 1));
  });
} finally {
  await Promise.all([
    removeOwnedS3Objects(s3Prefix),
    removeOwnedPath(stateDirectory, tmpdir(), "payload-blurhash-e2e-"),
    removeOwnedPath(
      path.join(appDirectory, enabledDistDirectory),
      appDirectory,
      ".next-e2e-payload-blurhash-e2e-",
    ),
    removeOwnedPath(
      path.join(appDirectory, disabledDistDirectory),
      appDirectory,
      ".next-e2e-payload-blurhash-e2e-",
    ),
    removeOwnedPath(
      path.join(appDirectory, enabledTsconfigPath),
      appDirectory,
      "tsconfig-e2e-payload-blurhash-e2e-",
    ),
    removeOwnedPath(
      path.join(appDirectory, disabledTsconfigPath),
      appDirectory,
      "tsconfig-e2e-payload-blurhash-e2e-",
    ),
  ]);
  process.off("SIGINT", handleInterrupt);
  process.off("SIGTERM", handleTerminate);
}

process.exitCode =
  interruptedSignal === "SIGINT" ? 130 : interruptedSignal === "SIGTERM" ? 143 : exitCode;
