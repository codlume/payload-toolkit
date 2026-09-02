import assert from "node:assert/strict";
import { test } from "vitest";

import { runCli } from "../../src/cli.ts";

test("rejects an unknown command with usage", async () => {
  await assert.rejects(runCli({ argv: ["publish-everything"], env: {}, log() {} }), {
    message:
      "Usage: node src/cli.ts <hold-draft|find-release-commit|prepare-pull-request|verify-tagged|publish>",
  });
});

test("GitHub commands require the repository and a token before touching GitHub", async () => {
  await assert.rejects(runCli({ argv: ["prepare-pull-request"], env: {}, log() {} }), {
    message: "Set GITHUB_REPOSITORY to owner/name.",
  });
  await assert.rejects(
    runCli({
      argv: ["hold-draft"],
      env: { GITHUB_REPOSITORY: "acme/toolkit" },
      log() {},
    }),
    { message: "Set GH_TOKEN or GITHUB_TOKEN." },
  );
});

test("find-release-commit requires the workflow outputs file", async () => {
  await assert.rejects(
    runCli({
      argv: ["find-release-commit"],
      env: { GH_TOKEN: "secret", GITHUB_REPOSITORY: "acme/toolkit" },
      log() {},
    }),
    { message: "Set GITHUB_OUTPUT to the workflow outputs file." },
  );
});

test("verify-tagged requires the merged Release pull request number", async () => {
  await assert.rejects(
    runCli({
      argv: ["verify-tagged"],
      env: { GH_TOKEN: "secret", GITHUB_REPOSITORY: "acme/toolkit", RELEASE_PR: "" },
      log() {},
    }),
    { message: "Set RELEASE_PR to the merged Release pull request number." },
  );
});
