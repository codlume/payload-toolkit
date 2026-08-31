import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubAdapter,
  createWorkingCopiesAdapter,
} from "./prepare-release-pull-request-adapters.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const PREPARED_HEAD = "2222222222222222222222222222222222222222";

function githubObservationAdapter({ pullHeads, refHeads, waits }) {
  return createGitHubAdapter({
    token: "secret",
    wait: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async (url) => {
      const { pathname } = new URL(url);
      if (pathname === "/graphql") {
        return Response.json({
          data: {
            repository: {
              pullRequests: {
                nodes: [
                  {
                    headRefName: "release-please--branches--main",
                    headRefOid: HEAD,
                    headRepository: { nameWithOwner: "acme/toolkit" },
                    isDraft: true,
                    number: 42,
                    state: "OPEN",
                  },
                ],
              },
            },
          },
        });
      }
      if (pathname.includes("/git/ref/heads/")) {
        return Response.json({ object: { sha: refHeads.shift() ?? refHeads.at(-1) } });
      }
      return Response.json({
        draft: true,
        head: {
          ref: "release-please--branches--main",
          repo: { full_name: "acme/toolkit" },
          sha: pullHeads.shift() ?? pullHeads.at(-1),
        },
        number: 42,
        state: "open",
      });
    },
  });
}

void test("waits for GitHub to observe the prepared head", async () => {
  const pullHeads = [HEAD, PREPARED_HEAD];
  const refHeads = [PREPARED_HEAD, PREPARED_HEAD];
  const waits = [];
  const github = githubObservationAdapter({ pullHeads, refHeads, waits });

  await github.findOpenReleasePullRequests("acme/toolkit");
  const observed = await github.observePullRequest(
    "acme/toolkit",
    42,
    "release-please--branches--main",
    PREPARED_HEAD,
    true,
  );

  assert.deepEqual(
    { headSha: observed.headSha, waits },
    { headSha: PREPARED_HEAD, waits: [1_000] },
  );
});

void test("reports an unexpected repository head without retrying", async () => {
  const waits = [];
  const unexpectedHead = "3333333333333333333333333333333333333333";
  const github = githubObservationAdapter({
    pullHeads: [HEAD],
    refHeads: [unexpectedHead],
    waits,
  });

  await github.findOpenReleasePullRequests("acme/toolkit");
  const observed = await github.observePullRequest(
    "acme/toolkit",
    42,
    "release",
    PREPARED_HEAD,
    true,
  );

  assert.deepEqual({ headSha: observed.headSha, waits }, { headSha: unexpectedHead, waits: [] });
});

void test("reports the stale repository head when observation retries are exhausted", async () => {
  const waits = [];
  const github = githubObservationAdapter({
    pullHeads: Array(10).fill(PREPARED_HEAD),
    refHeads: Array(10).fill(HEAD),
    waits,
  });

  await github.findOpenReleasePullRequests("acme/toolkit");
  const observed = await github.observePullRequest(
    "acme/toolkit",
    42,
    "release",
    PREPARED_HEAD,
    true,
  );

  assert.deepEqual({ headSha: observed.headSha, waits: waits.length }, { headSha: HEAD, waits: 9 });
});

function workingCopyFixture() {
  const commands = [];
  const removals = [];
  const token = "short-lived-token";
  const adapter = createWorkingCopiesAdapter({
    repository: "acme/toolkit",
    token,
    temporaryDirectory: "/runner/temp",
    execFile: async (command, args, options) => {
      commands.push({ args, command, options });
      if (args[0] === "status") {
        return {
          stdout: Buffer.from(" M packages/example/CHANGELOG.md\0?? unexpected.txt\0"),
        };
      }
      if (args[0] === "rev-parse") return { stdout: `${PREPARED_HEAD}\n` };
      return { stdout: "" };
    },
    fs: {
      async mkdtemp(prefix) {
        assert.equal(prefix, "/runner/temp/release-pull-request-");
        return "/runner/temp/release-pull-request-fixed";
      },
      async readFile() {
        return "contents";
      },
      async rm(path, options) {
        removals.push({ options, path });
      },
      async writeFile() {},
    },
  });

  return { adapter, commands, removals, token };
}

void test("removes the isolated working copy after preparation", async () => {
  const { adapter, removals } = workingCopyFixture();

  const result = await adapter.withExactHead(
    {
      headRef: "release-please--branches--main",
      headSha: HEAD,
    },
    (workingCopy) => workingCopy.head(),
  );

  assert.equal(result, PREPARED_HEAD);
  assert.deepEqual(removals, [
    {
      options: { force: true, recursive: true },
      path: "/runner/temp/release-pull-request-fixed",
    },
  ]);
});

void test("pushes only the selected branch with short-lived authentication", async () => {
  const { adapter, commands, token } = workingCopyFixture();

  await adapter.withExactHead(
    { headRef: "release-please--branches--main", headSha: HEAD },
    (workingCopy) => workingCopy.push("release-please--branches--main", HEAD),
  );

  const push = commands.find(({ args }) => args[0] === "push");
  assert.deepEqual(push.args, [
    "push",
    `--force-with-lease=refs/heads/release-please--branches--main:${HEAD}`,
    "https://github.com/acme/toolkit.git",
    "HEAD:refs/heads/release-please--branches--main",
  ]);
  assert.equal(JSON.stringify(commands).includes(token), false);
  assert.match(push.options.env.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
});

void test("reports every changed path from porcelain output", async () => {
  const { adapter } = workingCopyFixture();

  const paths = await adapter.withExactHead(
    { headRef: "release-please--branches--main", headSha: HEAD },
    (workingCopy) => workingCopy.changedPaths(),
  );

  assert.deepEqual(paths, ["packages/example/CHANGELOG.md", "unexpected.txt"]);
});
