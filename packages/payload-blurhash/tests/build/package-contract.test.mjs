import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const packageJSONPath = new URL("../../package.json", import.meta.url);
const distDirectory = new URL("../../dist/", import.meta.url);
const rootEntryPath = new URL("index.mjs", distDirectory);
const clientEntryPath = new URL("client.mjs", distDirectory);
const rootDeclarationPath = new URL("index.d.mts", distDirectory);
const clientDeclarationPath = new URL("client.d.mts", distDirectory);

const readPackageJSON = async () => JSON.parse(await readFile(packageJSONPath, "utf8"));

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
