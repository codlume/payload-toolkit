import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const repositoryDirectory = new URL("../../../../", import.meta.url);
const compatibilityRunnerPath = fileURLToPath(
  new URL("../../../../tests/compat/run.mjs", import.meta.url),
);

test("compatibility command rejects an unknown lane before running external commands", () => {
  const result = spawnSync(process.execPath, [compatibilityRunnerPath, "unsupported"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    env: { ...process.env, PATH: "" },
  });

  expect(result.status).toBe(1);
  expect(result.stderr).toMatch(
    /Unknown compatibility lane "unsupported"\. Expected one of: minimum, current\./u,
  );
});
