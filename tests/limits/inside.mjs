import { runCommand } from "../run-command.mjs";

await runCommand({
  arguments_: [
    "--filter",
    "@codlume/payload-blurhash",
    "exec",
    "vitest",
    "run",
    "tests/unit/blur-hash-generation.test.ts",
    "tests/unit/plugin.test.ts",
    "--maxWorkers=1",
  ],
  command: "pnpm",
});
await runCommand({
  arguments_: [
    "--expose-gc",
    "packages/payload-blurhash/tests/limits/measure.mjs",
    "/artifacts/blurhash-limits.json",
  ],
  command: process.execPath,
});
