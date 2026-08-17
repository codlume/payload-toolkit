import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const packageJSONPath = path.join(packageDirectory, "package.json");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const maximumCommandOutputBytes = 50 * 1024 * 1024;

const run = async (command, arguments_, cwd) => {
  try {
    return await execFileAsync(command, arguments_, {
      cwd,
      env: { ...process.env, CI: "1" },
      maxBuffer: maximumCommandOutputBytes,
    });
  } catch (error) {
    const output = [error.stdout, error.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${arguments_.join(" ")} failed${output.length === 0 ? "" : `:\n${output}`}`,
      { cause: error },
    );
  }
};

const readJSON = async (filePath) => JSON.parse(await readFile(filePath, "utf8"));

const readPackResult = (output) => {
  const parsed = JSON.parse(output.trim());
  assert.equal(parsed.length, 1, "npm pack must describe exactly one package");
  assert.equal(parsed[0].name, "@codlume/payload-blurhash");
  assert.equal(parsed[0].version, "0.0.0");
  return parsed[0];
};

const listFiles = async (directory, prefix = "") => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedFiles = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = path.posix.join(prefix, entry.name);

      if (entry.isDirectory()) {
        return listFiles(path.join(directory, entry.name), relativePath);
      }

      return entry.isFile() ? [relativePath] : [];
    }),
  );

  return nestedFiles.flat().toSorted((first, second) => first.localeCompare(second));
};

const assertPackageMetadata = (packageJSON) => {
  assert.deepEqual(
    {
      author: packageJSON.author,
      bugs: packageJSON.bugs,
      description: packageJSON.description,
      engines: packageJSON.engines,
      homepage: packageJSON.homepage,
      keywords: packageJSON.keywords,
      license: packageJSON.license,
      name: packageJSON.name,
      private: packageJSON.private,
      publishConfig: packageJSON.publishConfig,
      repository: packageJSON.repository,
      version: packageJSON.version,
    },
    {
      author: "Codlume",
      bugs: { url: "https://github.com/codlume/payload-toolkit/issues" },
      description:
        "A Payload CMS plugin that stores and previews BlurHash placeholders for uploaded images.",
      engines: { node: ">=22.12.0 <23 || >=24.0.0 <25" },
      homepage:
        "https://github.com/codlume/payload-toolkit/tree/main/packages/payload-blurhash#readme",
      keywords: ["blurhash", "cms", "image", "payload", "payloadcms", "placeholder", "plugin"],
      license: "MIT",
      name: "@codlume/payload-blurhash",
      private: true,
      publishConfig: { access: "public", registry: "https://registry.npmjs.org/" },
      repository: {
        directory: "packages/payload-blurhash",
        type: "git",
        url: "https://github.com/codlume/payload-toolkit.git",
      },
      version: "0.0.0",
    },
  );
};

const getExportTargets = (packageJSON) =>
  Object.values(packageJSON.exports)
    .flatMap((conditions) => Object.values(conditions))
    .map((target) => target.replace(/^\.\//u, ""));

const forbiddenBuiltArtifactPatterns = [
  /(^|\/)(?:apps?|applications?|fixtures?|sources?|src|tests?)(?:[./]|$)/iu,
  /(^|\/)(?:caches?|\.cache)(?:[./]|$)/iu,
  /(^|\/)\.env(?:\.|$)/iu,
  /(^|\/)[^/]*secret[^/]*(?:\/|$)/iu,
  /(^|\/)(?:[^/]+\.config\.(?:js|mjs|ts)|tsconfig(?:\.[^/]*)?\.json)$/iu,
];

const assertBuiltArtifactIsPublishable = (filePath) => {
  assert.match(
    filePath,
    /^dist\/.+\.(?:css|d\.mts|mjs)$/u,
    `packed dist path is not a built runtime artifact: ${filePath}`,
  );

  for (const pattern of forbiddenBuiltArtifactPatterns) {
    assert.doesNotMatch(filePath, pattern, `packed dist path is forbidden: ${filePath}`);
  }
};

const assertPackedContents = async (packResult, packageJSON) => {
  const packedFiles = new Set(packResult.files.map((file) => file.path));
  const builtFiles = (await listFiles(path.join(packageDirectory, "dist"))).map(
    (file) => `dist/${file}`,
  );
  const requiredFiles = new Set([
    "package.json",
    "README.md",
    "LICENSE",
    ...getExportTargets(packageJSON),
    ...builtFiles,
  ]);

  for (const requiredFile of requiredFiles) {
    assert.ok(packedFiles.has(requiredFile), `packed tarball is missing ${requiredFile}`);
  }

  for (const packedFile of packedFiles) {
    assert.ok(
      packedFile === "package.json" ||
        packedFile === "README.md" ||
        packedFile === "LICENSE" ||
        packedFile.startsWith("dist/"),
      `packed tarball contains forbidden path ${packedFile}`,
    );
    assert.ok(!packedFile.endsWith(".map"), `packed tarball contains source map ${packedFile}`);

    if (packedFile.startsWith("dist/")) {
      assertBuiltArtifactIsPublishable(packedFile);
    }
  }
};

const writeConsumer = async (consumerDirectory, tarballFilename, packageJSON) => {
  const developmentDependencyVersions = packageJSON.devDependencies;
  const consumerPackageJSON = {
    name: "payload-blurhash-clean-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
    dependencies: {
      "@codlume/payload-blurhash": `file:../${tarballFilename}`,
      "@payloadcms/db-sqlite": developmentDependencyVersions["@payloadcms/db-sqlite"],
      "@payloadcms/next": developmentDependencyVersions["@payloadcms/next"],
      "@payloadcms/ui": developmentDependencyVersions["@payloadcms/ui"],
      graphql: developmentDependencyVersions.graphql,
      next: developmentDependencyVersions.next,
      payload: developmentDependencyVersions.payload,
      react: developmentDependencyVersions.react,
      "react-dom": developmentDependencyVersions["react-dom"],
      sharp: developmentDependencyVersions.sharp,
    },
    devDependencies: {
      "@types/react": developmentDependencyVersions["@types/react"],
      "@types/react-dom": developmentDependencyVersions["@types/react-dom"],
      typescript: developmentDependencyVersions.typescript,
    },
  };
  const configSource = `import { blurHashPlugin } from "@codlume/payload-blurhash";
import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { fileURLToPath } from "node:url";
import { buildConfig } from "payload";
import sharp from "sharp";

export default buildConfig({
  admin: {
    importMap: {
      importMapFile: fileURLToPath(new URL("./import-map.mjs", import.meta.url)),
    },
    user: "users",
  },
  collections: [
    { slug: "users", auth: true, fields: [] },
    { slug: "media", upload: true, fields: [] },
  ],
  db: sqliteAdapter({
    client: { url: \`file:\${fileURLToPath(new URL("./payload.db", import.meta.url))}\` },
  }),
  plugins: [blurHashPlugin({ collections: ["media"] })],
  secret: "payload-blurhash-clean-consumer-secret",
  sharp,
  telemetry: false,
});
`;
  const typecheckSource = `import { blurHashPlugin, type BlurHashPluginOptions } from "@codlume/payload-blurhash";
import { BlurHashPreview } from "@codlume/payload-blurhash/client";

const options = { collections: ["media"] } satisfies BlurHashPluginOptions;
const plugin = blurHashPlugin(options);
const preview: typeof BlurHashPreview = BlurHashPreview;

void plugin;
void preview;
`;
  const serverAssertionSource = `import assert from "node:assert/strict";
import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as serverEntry from "@codlume/payload-blurhash";
import { getPayload } from "payload";

import config from "./payload.config.js";

const consumerDirectory = fileURLToPath(new URL("./", import.meta.url));
const serverEntryPath = fileURLToPath(import.meta.resolve("@codlume/payload-blurhash"));
const clientEntryPath = fileURLToPath(import.meta.resolve("@codlume/payload-blurhash/client"));
const installedPackageDirectory = path.dirname(path.dirname(serverEntryPath));
const installedPackageJSON = JSON.parse(
  await readFile(path.join(installedPackageDirectory, "package.json"), "utf8"),
);

test("server ESM entry exposes only the plugin function", () => {
  assert.deepEqual(Object.keys(serverEntry), ["blurHashPlugin"]);
});

test("manifest entry points resolve to built JavaScript and declarations", async () => {
  await Promise.all([
    access(path.join(installedPackageDirectory, installedPackageJSON.exports["."].types)),
    access(path.join(installedPackageDirectory, installedPackageJSON.exports["./client"].types)),
  ]);

  assert.deepEqual(
    {
      client: clientEntryPath.endsWith("/dist/client.mjs"),
      server: serverEntryPath.endsWith("/dist/index.mjs"),
    },
    { client: true, server: true },
  );
});

test("installed tarball has no workspace or repository-source linkage", async () => {
  const lockfile = await readFile(new URL("./pnpm-lock.yaml", import.meta.url), "utf8");

  assert.deepEqual(
    {
      insideConsumer: (await realpath(installedPackageDirectory)).startsWith(
        await realpath(consumerDirectory),
      ),
      workspaceReference: /workspace:/u.test(lockfile),
    },
    { insideConsumer: true, workspaceReference: false },
  );
});

test("minimal Payload config initializes with the installed plugin", async () => {
  const payload = await getPayload({ config });

  try {
    assert.equal(payload.config.collections.some(({ slug }) => slug === "media"), true);
  } finally {
    await payload.destroy();
  }
});
`;
  const clientAssertionSource = `import assert from "node:assert/strict";
import test from "node:test";

import * as clientEntry from "@codlume/payload-blurhash/client";
import { BlurHashPreview } from "@codlume/payload-blurhash/client";

import { importMap } from "./import-map.mjs";

test("client ESM entry exposes only the preview component", () => {
  assert.deepEqual(Object.keys(clientEntry), ["BlurHashPreview"]);
});

test("generated import map resolves the named preview export", () => {
  assert.equal(
    importMap["@codlume/payload-blurhash/client#BlurHashPreview"],
    BlurHashPreview,
  );
});
`;
  const cssLoaderSource = `export const load = async (url, context, nextLoad) => {
  if (url.endsWith(".css") || url.endsWith(".scss")) {
    return { format: "module", shortCircuit: true, source: "export default undefined;" };
  }

  return nextLoad(url, context);
};
`;
  const typeScriptConfig = {
    compilerOptions: {
      exactOptionalPropertyTypes: true,
      jsx: "react-jsx",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      noEmit: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
    },
    include: ["contract.ts"],
  };

  await Promise.all([
    writeFile(
      path.join(consumerDirectory, "package.json"),
      `${JSON.stringify(consumerPackageJSON, null, 2)}\n`,
    ),
    writeFile(path.join(consumerDirectory, "payload.config.js"), configSource),
    writeFile(path.join(consumerDirectory, "contract.ts"), typecheckSource),
    writeFile(path.join(consumerDirectory, "assert-client.mjs"), clientAssertionSource),
    writeFile(path.join(consumerDirectory, "assert-server.mjs"), serverAssertionSource),
    writeFile(path.join(consumerDirectory, "ignore-css-loader.mjs"), cssLoaderSource),
    writeFile(
      path.join(consumerDirectory, "tsconfig.json"),
      `${JSON.stringify(typeScriptConfig, null, 2)}\n`,
    ),
  ]);
};

const verifyCleanConsumer = async (consumerDirectory) => {
  await run(
    pnpmCommand,
    ["install", "--lockfile-only", "--ignore-workspace", "--strict-peer-dependencies"],
    consumerDirectory,
  );
  await run(
    pnpmCommand,
    ["install", "--frozen-lockfile", "--ignore-workspace", "--strict-peer-dependencies"],
    consumerDirectory,
  );
  await run(pnpmCommand, ["exec", "tsc", "--noEmit"], consumerDirectory);
  await run(pnpmCommand, ["exec", "payload", "generate:importmap"], consumerDirectory);
  await run(process.execPath, ["--test", "assert-server.mjs"], consumerDirectory);
  await run(
    process.execPath,
    ["--experimental-loader", "./ignore-css-loader.mjs", "--test", "assert-client.mjs"],
    consumerDirectory,
  );
};

let temporaryDirectory;

try {
  console.log("Building package...");
  await run(pnpmCommand, ["build"], packageDirectory);

  const packageJSON = await readJSON(packageJSONPath);
  assertPackageMetadata(packageJSON);

  console.log("Checking dry-run packed contents...");
  const dryRun = await run(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    packageDirectory,
  );
  await assertPackedContents(readPackResult(dryRun.stdout), packageJSON);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "payload-blurhash-pack-"));
  console.log("Creating real tarball...");
  const packed = await run(
    npmCommand,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", temporaryDirectory],
    packageDirectory,
  );
  const tarballFilename = readPackResult(packed.stdout).filename;
  const tarballPath = path.join(temporaryDirectory, tarballFilename);
  await access(tarballPath);

  const consumerDirectory = path.join(temporaryDirectory, "consumer");
  await mkdir(consumerDirectory);
  await writeConsumer(consumerDirectory, tarballFilename, packageJSON);

  console.log("Installing and verifying clean consumer...");
  await verifyCleanConsumer(consumerDirectory);
  console.log("Packed tarball and clean consumer verified.");
} finally {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { force: true, recursive: true });
  }
}
