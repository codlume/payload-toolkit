// Runs this package's unit and integration suites against another Payload 3.x
// release in a disposable copy, leaving the workspace and its lockfile untouched.
// Usage: node tests/compat/run.mjs <payload-version>
// The active Node must satisfy that Payload release's engines range.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../../../../tests/run-command.mjs";

const payloadVersion = process.argv[2];
if (!payloadVersion || !/^3\.\d+\.\d+$/u.test(payloadVersion)) {
  throw new Error("Pass an exact Payload 3.x version, for example 3.93.0.");
}

const packageDirectory = fileURLToPath(new URL("../../", import.meta.url));
const repositoryDirectory = path.resolve(packageDirectory, "../..");
const rootPackageJSON = JSON.parse(
  await readFile(path.join(repositoryDirectory, "package.json"), "utf8"),
);
const workDirectory = await mkdtemp(path.join(tmpdir(), "payload-roles-compat-"));
const copyDirectory = path.join(workDirectory, "packages", "payload-roles");

try {
  await cp(packageDirectory, copyDirectory, {
    filter: (source) => !/[/\\](node_modules|dist)([/\\]|$)/u.test(source),
    recursive: true,
  });
  await cp(
    path.join(repositoryDirectory, "tsconfig.base.json"),
    path.join(workDirectory, "tsconfig.base.json"),
  );
  await cp(path.join(repositoryDirectory, "tests"), path.join(workDirectory, "tests"), {
    recursive: true,
  });

  const packageJSONPath = path.join(copyDirectory, "package.json");
  const packageJSON = JSON.parse(await readFile(packageJSONPath, "utf8"));
  for (const name of Object.keys(packageJSON.devDependencies)) {
    if (name === "payload" || name.startsWith("@payloadcms/")) {
      packageJSON.devDependencies[name] = payloadVersion;
    }
  }
  packageJSON.devDependencies["vite-plus"] = rootPackageJSON.devDependencies["vite-plus"];
  await writeFile(packageJSONPath, `${JSON.stringify(packageJSON, null, 2)}\n`);

  // pnpm 11 fails an install whose build scripts are not approved. The disposable
  // install approves exactly the packages the workspace root already approves.
  const rootWorkspace = await readFile(
    path.join(repositoryDirectory, "pnpm-workspace.yaml"),
    "utf8",
  );
  const allowBuilds = /^allowBuilds:\n(?:[ \t]+.*\n?)+/mu.exec(rootWorkspace)?.[0];
  if (!allowBuilds) {
    throw new Error("The root pnpm-workspace.yaml declares no allowBuilds.");
  }
  await writeFile(path.join(copyDirectory, "pnpm-workspace.yaml"), allowBuilds);

  const run = (arguments_) =>
    runCommand({ arguments_, command: "pnpm", cwd: copyDirectory, env: process.env });
  await run(["install", "--config.minimum-release-age=0"]);
  const installed = JSON.parse(
    await readFile(path.join(copyDirectory, "node_modules/payload/package.json"), "utf8"),
  );
  console.log(`Installed payload ${installed.version} on Node ${process.version}`);
  if (installed.version !== payloadVersion) {
    throw new Error(`Expected payload ${payloadVersion}, installed ${installed.version}.`);
  }
  await run(["test:unit"]);
  await run(["test:integration"]);
  console.log(`payload-roles suites passed on payload ${payloadVersion}`);
} finally {
  await rm(workDirectory, { force: true, recursive: true });
}
