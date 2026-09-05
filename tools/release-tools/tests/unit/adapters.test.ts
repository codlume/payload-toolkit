import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createGitHubAdapter,
  createWorkingCopiesAdapter,
  createWorkspaceAdapter,
} from "../../src/adapters.ts";

const HEAD = "1111111111111111111111111111111111111111";
const PREPARED_HEAD = "2222222222222222222222222222222222222222";

function githubObservationAdapter({
  pullHeads,
  refHeads,
  waits,
}: {
  pullHeads: string[];
  refHeads: string[];
  waits: number[];
}) {
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
                    body: null,
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
        body: null,
        draft: true,
        head: {
          ref: "release-please--branches--main",
          repo: { full_name: "acme/toolkit" },
          sha: pullHeads.shift() ?? pullHeads.at(-1),
        },
        node_id: "PR_42",
        number: 42,
        state: "open",
      });
    },
  });
}

test("waits for GitHub to observe the prepared head", async () => {
  const pullHeads = [HEAD, PREPARED_HEAD];
  const refHeads = [PREPARED_HEAD, PREPARED_HEAD];
  const waits: number[] = [];
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

test("reports an unexpected repository head without retrying", async () => {
  const waits: number[] = [];
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

test("reports the stale repository head when observation retries are exhausted", async () => {
  const waits: number[] = [];
  const github = githubObservationAdapter({
    pullHeads: Array<string>(10).fill(PREPARED_HEAD),
    refHeads: Array<string>(10).fill(HEAD),
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

type RecordedCommand = {
  args: string[];
  command: string;
  options: { cwd?: string; env?: NodeJS.ProcessEnv } | undefined;
};

function workingCopyFixture() {
  const commands: RecordedCommand[] = [];
  const removals: { options: { force: boolean; recursive: boolean }; path: string }[] = [];
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

test("removes the isolated working copy after preparation", async () => {
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

test("pushes only the selected branch with short-lived authentication", async () => {
  const { adapter, commands, token } = workingCopyFixture();

  await adapter.withExactHead(
    { headRef: "release-please--branches--main", headSha: HEAD },
    (workingCopy) => workingCopy.push("release-please--branches--main", HEAD),
  );

  const push = commands.find(({ args }) => args[0] === "push");
  assert.deepEqual(push?.args, [
    "push",
    `--force-with-lease=refs/heads/release-please--branches--main:${HEAD}`,
    "https://github.com/acme/toolkit.git",
    "HEAD:refs/heads/release-please--branches--main",
  ]);
  assert.equal(JSON.stringify(commands).includes(token), false);
  assert.match(push?.options?.env?.GIT_CONFIG_VALUE_0 ?? "", /^AUTHORIZATION: basic /);
});

test("reports every changed path from porcelain output", async () => {
  const { adapter } = workingCopyFixture();

  const paths = await adapter.withExactHead(
    { headRef: "release-please--branches--main", headSha: HEAD },
    (workingCopy) => workingCopy.changedPaths(),
  );

  assert.deepEqual(paths, ["packages/example/CHANGELOG.md", "unexpected.txt"]);
});

test("reads the newest merged Release pull request with its labels", async () => {
  const github = createGitHubAdapter({
    token: "secret",
    fetchImpl: async () =>
      Response.json({
        data: {
          repository: {
            pullRequests: {
              nodes: [
                {
                  labels: { nodes: [{ name: "autorelease: tagged" }] },
                  mergeCommit: { oid: PREPARED_HEAD },
                  number: 7,
                },
              ],
            },
          },
        },
      }),
  });

  assert.deepEqual(await github.findNewestMergedReleasePullRequest("acme/toolkit"), {
    labels: ["autorelease: tagged"],
    mergeCommitSha: PREPARED_HEAD,
    number: 7,
  });
});

test("reads a pull request's label names", async () => {
  const github = createGitHubAdapter({
    token: "secret",
    fetchImpl: async () =>
      Response.json({
        body: null,
        draft: false,
        head: { ref: "release-please--branches--main", repo: null, sha: HEAD },
        labels: [{ name: "autorelease: pending" }],
        node_id: "PR_7",
        number: 7,
        state: "closed",
      }),
  });

  assert.deepEqual(await github.pullRequestLabels("acme/toolkit", 7), ["autorelease: pending"]);
});

test("lists package names from the packages directories only, in order", async () => {
  const workspace = createWorkspaceAdapter({
    cwd: "/release",
    fs: {
      async readdir() {
        return [
          { isDirectory: () => true, name: "payload-blurhash" },
          { isDirectory: () => false, name: ".DS_Store" },
          { isDirectory: () => true, name: "payload-activity" },
        ];
      },
      async readFile(path) {
        return JSON.stringify({ name: `@codlume/${path.split("/").at(-2)}` });
      },
    },
    run: async () => 0,
  });

  assert.deepEqual(await workspace.listPackageNames(), [
    "@codlume/payload-activity",
    "@codlume/payload-blurhash",
  ]);
});

test("publishes through pnpm's recursive publish and reports a non-zero exit", async () => {
  const commands: string[][] = [];
  const workspace = createWorkspaceAdapter({
    cwd: "/release",
    run: async (command, args) => {
      commands.push([command, ...args]);
      return args.includes("@codlume/payload-activity") ? 1 : 0;
    },
  });

  const results = [
    await workspace.publish("@codlume/payload-activity"),
    await workspace.publish("@codlume/payload-blurhash"),
  ];

  assert.deepEqual(
    { commands, results },
    {
      commands: [
        ["pnpm", "-r", "--filter", "@codlume/payload-activity", "publish", "--no-git-checks"],
        ["pnpm", "-r", "--filter", "@codlume/payload-blurhash", "publish", "--no-git-checks"],
      ],
      results: [false, true],
    },
  );
});
