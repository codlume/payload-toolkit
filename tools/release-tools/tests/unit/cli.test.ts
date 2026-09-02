import assert from "node:assert/strict";
import { test } from "vitest";

import { runCli } from "../../src/cli.ts";

test("rejects an unknown command with usage", async () => {
  await assert.rejects(runCli({ argv: ["publish-everything"], env: {}, log() {} }), {
    message: "Usage: node src/cli.ts <prepare-pull-request>",
  });
});

test("prepare-pull-request requires the repository and a token before touching GitHub", async () => {
  await assert.rejects(runCli({ argv: ["prepare-pull-request"], env: {}, log() {} }), {
    message: "Set GITHUB_REPOSITORY to owner/name.",
  });
  await assert.rejects(
    runCli({
      argv: ["prepare-pull-request"],
      env: { GITHUB_REPOSITORY: "acme/toolkit" },
      log() {},
    }),
    { message: "Set GH_TOKEN or GITHUB_TOKEN." },
  );
});
