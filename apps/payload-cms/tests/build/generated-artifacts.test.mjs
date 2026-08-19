import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const appDirectory = fileURLToPath(new URL("../../", import.meta.url));
const committedTypesPath = path.join(appDirectory, "src/payload-types.generated.ts");
const committedImportMapPath = path.join(
  appDirectory,
  "src/app/(payload)/admin/importMap.js",
);

let temporaryDirectory;
let generatedTypesPath;
let generatedImportMapPath;

const runPayload = (command, environment) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "payload", command, "--config", "src/payload.config.ts"],
      {
        cwd: appDirectory,
        env: { ...process.env, ...environment },
        stdio: "inherit",
      },
    );

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`payload ${command} exited with ${code ?? signal}`));
    });
  });

before(async () => {
  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-generated-"));
  generatedTypesPath = path.join(temporaryDirectory, "payload-types.generated.ts");
  generatedImportMapPath = path.join(temporaryDirectory, "importMap.js");
  const environment = {
    PAYLOAD_IMPORT_MAP_FILE: generatedImportMapPath,
    PAYLOAD_STATE_DIRECTORY: path.join(temporaryDirectory, "state"),
    PAYLOAD_TS_OUTPUT_PATH: generatedTypesPath,
  };

  await runPayload("generate:types", environment);
  await runPayload("generate:importmap", environment);
});

after(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
});

test("Payload types match the committed application schema", async () => {
  const [committedTypes, generatedTypes] = await Promise.all([
    readFile(committedTypesPath, "utf8"),
    readFile(generatedTypesPath, "utf8"),
  ]);

  assert.deepEqual(
    {
      containsBlurHash: /blurHash\?: string \| null;/u.test(generatedTypes),
      containsLastModifiedBy:
        /lastModifiedBy\?: \(number \| null\) \| User;/u.test(generatedTypes),
      content: generatedTypes,
    },
    {
      containsBlurHash: true,
      containsLastModifiedBy: true,
      content: committedTypes,
    },
    "Payload types are out of date",
  );
});

test("Payload import map matches the committed Admin components", async () => {
  const [committedImportMap, generatedImportMap] = await Promise.all([
    readFile(committedImportMapPath, "utf8"),
    readFile(generatedImportMapPath, "utf8"),
  ]);

  assert.deepEqual(
    {
      containsBlurHashPreview:
        /"@codlume\/payload-blurhash\/client#BlurHashPreview"/u.test(generatedImportMap),
      content: generatedImportMap,
    },
    {
      containsBlurHashPreview: true,
      content: committedImportMap,
    },
    "Payload import map is out of date",
  );
});

test("Admin preview resolves through the installed package client export", () => {
  assert.ok(
    fileURLToPath(import.meta.resolve("@codlume/payload-blurhash/client")).endsWith(
      path.join("dist", "client.mjs"),
    ),
  );
});
