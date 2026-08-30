import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "./wait-for-release-pr-head.mjs";

const PREVIOUS_HEAD = "1111111111111111111111111111111111111111";
const EXPECTED_HEAD = "2222222222222222222222222222222222222222";

function cliArguments() {
  return [
    "--repo",
    "acme/toolkit",
    "--pr",
    "42",
    "--head-ref",
    "release-please--branches--main",
    "--previous-head",
    PREVIOUS_HEAD,
    "--expected-head",
    EXPECTED_HEAD,
  ];
}

void test("waits for the repository ref to observe the pushed head", async () => {
  const repositoryHeads = [PREVIOUS_HEAD, EXPECTED_HEAD];
  const waits = [];

  const pullRequest = await runCli({
    argv: cliArguments(),
    env: { GH_TOKEN: "secret" },
    execFile: async (_command, args) => {
      if (args[0] === "api") return { stdout: repositoryHeads.shift() };
      return {
        stdout: JSON.stringify({
          isDraft: true,
          state: "OPEN",
        }),
      };
    },
    wait: async (milliseconds) => waits.push(milliseconds),
  });

  assert.deepEqual(
    { pullRequest, waits },
    {
      pullRequest: {
        headRefOid: EXPECTED_HEAD,
        isDraft: true,
        state: "OPEN",
      },
      waits: [1_000],
    },
  );
});

void test("rejects a release PR head changed by another writer", async () => {
  const unexpectedHead = "3333333333333333333333333333333333333333";

  await assert.rejects(
    runCli({
      argv: cliArguments(),
      env: { GH_TOKEN: "secret" },
      execFile: async (_command, args) => {
        if (args[0] === "api") return { stdout: unexpectedHead };
        return {
          stdout: JSON.stringify({ isDraft: true, state: "OPEN" }),
        };
      },
      wait: async () => {
        throw new Error("An unexpected head must not be retried.");
      },
    }),
    {
      message: `Release PR #42 moved to ${unexpectedHead} while waiting for ${EXPECTED_HEAD}.`,
    },
  );
});

void test("bounds how long a stale repository head is retried", async () => {
  let repositoryReads = 0;
  const waits = [];

  await assert.rejects(
    runCli({
      argv: cliArguments(),
      env: { GH_TOKEN: "secret" },
      execFile: async (_command, args) => {
        if (args[0] === "api") {
          repositoryReads += 1;
          return { stdout: PREVIOUS_HEAD };
        }
        return { stdout: JSON.stringify({ isDraft: true, state: "OPEN" }) };
      },
      wait: async (milliseconds) => waits.push(milliseconds),
    }),
    {
      message: `Release PR #42 still reports ${PREVIOUS_HEAD} after 10 checks; expected ${EXPECTED_HEAD}.`,
    },
  );

  assert.deepEqual(
    { repositoryReads, waits },
    {
      repositoryReads: 10,
      waits: Array(9).fill(1_000),
    },
  );
});

void test("rejects a release PR that is no longer a draft", async () => {
  await assert.rejects(
    runCli({
      argv: cliArguments(),
      env: { GH_TOKEN: "secret" },
      execFile: async (_command, args) => {
        if (args[0] === "api") return { stdout: EXPECTED_HEAD };
        return { stdout: JSON.stringify({ isDraft: false, state: "OPEN" }) };
      },
      wait: async () => {
        throw new Error("A ready pull request must not be retried.");
      },
    }),
    { message: "Release PR #42 is no longer an open draft." },
  );
});
