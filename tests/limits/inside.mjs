import { runCommand } from "./run-command.mjs";

await runCommand("pnpm", [
  "--filter",
  "@codlume/payload-blurhash",
  "exec",
  "vitest",
  "run",
  "tests/unit/generate-blur-hash.test.ts",
  "tests/unit/plugin.test.ts",
  "--maxWorkers=1",
]);
await runCommand(process.execPath, [
  "--expose-gc",
  "packages/payload-blurhash/tests/limits/measure.mjs",
  "/artifacts/blurhash-limits.json",
]);
