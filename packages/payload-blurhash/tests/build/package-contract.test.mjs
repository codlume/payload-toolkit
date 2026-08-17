import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageJSONPath = new URL("../../package.json", import.meta.url);
const rootPackageJSONPath = new URL("../../../../package.json", import.meta.url);
const readmePath = new URL("../../README.md", import.meta.url);
const licensePath = new URL("../../LICENSE", import.meta.url);
const distDirectory = new URL("../../dist/", import.meta.url);
const rootEntryPath = new URL("index.mjs", distDirectory);
const clientEntryPath = new URL("client.mjs", distDirectory);
const rootDeclarationPath = new URL("index.d.mts", distDirectory);
const clientDeclarationPath = new URL("client.d.mts", distDirectory);

const readPackageJSON = async () => JSON.parse(await readFile(packageJSONPath, "utf8"));

test("README covers the unreleased consumer contract", async () => {
  const readme = await readFile(readmePath, "utf8");
  const requiredHeadings = [
    "# Payload BlurHash",
    "## Unreleased",
    "## Compatibility",
    "## Configuration",
    "## Field and API behavior",
    "## Supported media",
    "## Resource limits",
    "## Logging and privacy",
    "## Admin preview",
    "## Disabled mode and existing media",
    "## Development",
    "## License",
  ];

  assert.deepEqual(
    requiredHeadings.filter((heading) => !readme.split("\n").includes(heading)),
    [],
  );
});

test("README states the supported Payload and Node ranges", async () => {
  const readme = await readFile(readmePath, "utf8");

  assert.deepEqual(
    {
      node: /Node >=22\.12\.0 <23 \|\| >=24\.0\.0 <25/u.test(readme),
      payload: /Payload >=3\.88\.0 <4/u.test(readme),
    },
    { node: true, payload: true },
  );
});

test("package includes the complete Codlume MIT license", async () => {
  const license = await readFile(licensePath, "utf8");

  assert.deepEqual(
    {
      copyright: /Copyright \(c\) 2026 Codlume/u.test(license),
      grant: /Permission is hereby granted, free of charge/u.test(license),
      heading: /^MIT License$/mu.test(license),
      warranty: /THE SOFTWARE IS PROVIDED "AS IS"/u.test(license),
    },
    { copyright: true, grant: true, heading: true, warranty: true },
  );
});

test("package declares runtime and host relationships without bundling Sharp", async () => {
  const packageJSON = await readPackageJSON();

  assert.deepEqual(
    {
      dependencies: packageJSON.dependencies,
      developmentHosts: {
        graphql: packageJSON.devDependencies.graphql,
        next: packageJSON.devDependencies.next,
        payloadNext: packageJSON.devDependencies["@payloadcms/next"],
        payload: packageJSON.devDependencies.payload,
        react: packageJSON.devDependencies.react,
        reactDOM: packageJSON.devDependencies["react-dom"],
        sharp: packageJSON.devDependencies.sharp,
        ui: packageJSON.devDependencies["@payloadcms/ui"],
      },
      peers: packageJSON.peerDependencies,
    },
    {
      dependencies: {
        blurhash: "2.0.5",
      },
      developmentHosts: {
        graphql: "16.14.2",
        next: "15.4.11",
        payloadNext: "3.88.0",
        payload: "3.88.0",
        react: "19.2.8",
        reactDOM: "19.2.8",
        sharp: "0.35.3",
        ui: "3.88.0",
      },
      peers: {
        "@payloadcms/ui": ">=3.88.0 <4",
        payload: ">=3.88.0 <4",
        react: "^19.0.1 || ^19.1.2 || ^19.2.1",
        "react-dom": "^19.0.1 || ^19.1.2 || ^19.2.1",
      },
    },
  );
});

test("package owns the tarball gate exposed from the workspace root", async () => {
  const [packageJSON, rootPackageJSON] = await Promise.all([
    readPackageJSON(),
    readFile(rootPackageJSONPath, "utf8").then(JSON.parse),
  ]);

  assert.deepEqual(
    {
      package: packageJSON.scripts["test:pack"],
      root: rootPackageJSON.scripts["test:pack"],
    },
    {
      package: "node tests/pack/run.mjs",
      root: "pnpm --filter @codlume/payload-blurhash test:pack",
    },
  );
});

const parseModule = async (modulePath) =>
  ts.createSourceFile(
    fileURLToPath(modulePath),
    await readFile(modulePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

const getModuleSpecifiers = (sourceFile) => {
  const specifiers = [];

  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      specifiers.push(node.arguments[0].text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...new Set(specifiers)].sort();
};

const getDirectives = (sourceFile) => {
  const directives = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression)) {
      break;
    }

    directives.push(statement.expression.text);
  }

  return directives;
};

const getDeclarationExports = (modulePaths) => {
  const filePaths = modulePaths.map((modulePath) => fileURLToPath(modulePath));
  const program = ts.createProgram(filePaths, {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  });
  const checker = program.getTypeChecker();

  return Object.fromEntries(
    filePaths.map((filePath) => {
      const sourceFile = program.getSourceFile(filePath);
      const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);

      if (!moduleSymbol) {
        throw new Error(`Could not inspect declaration exports for ${filePath}`);
      }

      return [
        filePath,
        checker
          .getExportsOfModule(moduleSymbol)
          .map((symbol) => symbol.name)
          .sort(),
      ];
    }),
  );
};

test("package exposes only its built ESM server and client entry points", async () => {
  const packageJSON = await readPackageJSON();

  assert.deepEqual(
    {
      exports: packageJSON.exports,
      main: packageJSON.main,
      module: packageJSON.module,
      sideEffects: packageJSON.sideEffects,
      type: packageJSON.type,
      types: packageJSON.types,
    },
    {
      exports: {
        ".": {
          types: "./dist/index.d.mts",
          import: "./dist/index.mjs",
        },
        "./client": {
          types: "./dist/client.d.mts",
          import: "./dist/client.mjs",
        },
      },
      main: undefined,
      module: undefined,
      sideEffects: false,
      type: "module",
      types: undefined,
    },
  );
});

test("build emits only the four documented ESM artifacts", async () => {
  assert.deepEqual((await readdir(distDirectory)).sort(), [
    "client.d.mts",
    "client.mjs",
    "index.d.mts",
    "index.mjs",
  ]);
});

test("server entry exposes only the plugin function at runtime", async () => {
  assert.deepEqual(Object.keys(await import("@codlume/payload-blurhash")), ["blurHashPlugin"]);
});

test("declarations expose only the documented server and client names", async () => {
  const exportsByPath = getDeclarationExports([rootDeclarationPath, clientDeclarationPath]);

  assert.deepEqual(
    {
      client: exportsByPath[fileURLToPath(clientDeclarationPath)],
      root: exportsByPath[fileURLToPath(rootDeclarationPath)],
    },
    {
      client: ["BlurHashPreview"],
      root: ["BlurHashPluginOptions", "blurHashPlugin"],
    },
  );
});

test("client artifact retains only its JavaScript client directive", async () => {
  const [clientModule, clientDeclaration] = await Promise.all([
    parseModule(clientEntryPath),
    parseModule(clientDeclarationPath),
  ]);

  assert.deepEqual(
    {
      declaration: getDirectives(clientDeclaration),
      javascript: getDirectives(clientModule),
    },
    {
      declaration: [],
      javascript: ["use client"],
    },
  );
});

test("server and client artifacts keep their runtime dependencies isolated", async () => {
  const [rootArtifact, clientArtifact] = await Promise.all([
    parseModule(rootEntryPath),
    parseModule(clientEntryPath),
  ]);
  const rootSpecifiers = getModuleSpecifiers(rootArtifact);
  const clientSpecifiers = getModuleSpecifiers(clientArtifact);

  assert.deepEqual(
    {
      clientServerImports: clientSpecifiers.filter(
        (specifier) =>
          specifier === "payload" || specifier === "sharp" || specifier.startsWith("node:"),
      ),
      serverClientImports: rootSpecifiers.filter(
        (specifier) => specifier === "@payloadcms/ui" || specifier.startsWith("react"),
      ),
    },
    {
      clientServerImports: [],
      serverClientImports: [],
    },
  );
});

test("Payload UI is an explicit host relationship", async () => {
  const packageJSON = await readPackageJSON();

  assert.deepEqual(
    {
      development: packageJSON.devDependencies["@payloadcms/ui"],
      peer: packageJSON.peerDependencies["@payloadcms/ui"],
    },
    {
      development: "3.88.0",
      peer: ">=3.88.0 <4",
    },
  );
});
