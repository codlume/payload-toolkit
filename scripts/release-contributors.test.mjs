import assert from "node:assert/strict";
import test from "node:test";

import { prepareReleaseContributors, runCli } from "./release-contributors.mjs";

const SHA = "abc123456789abc123456789abc123456789abcd";

function releaseBullet(sha = SHA) {
  return `* fix the preview ([#12](https://github.com/acme/toolkit/issues/12)) ([${sha.slice(0, 7)}](https://github.com/acme/toolkit/commit/${sha}))`;
}

void test("credits a contributor in the release body and current changelog version", () => {
  const pullRequestBody = ["<details>", "", releaseBullet(), "", "</details>"].join("\n");
  const currentVersion = ["## 1.1.0", "", releaseBullet()].join("\n");
  const previousVersion = ["## 1.0.0", "", releaseBullet()].join("\n");
  const changelog = ["# Changelog", "", currentVersion, "", previousVersion].join("\n");

  assert.deepEqual(
    prepareReleaseContributors({
      pullRequestBody,
      changelogs: [{ path: "packages/example/CHANGELOG.md", contents: changelog }],
      pullRequestsByCommit: new Map([
        [
          SHA,
          [
            {
              merge_commit_sha: SHA,
              merged_at: "2026-08-30T12:00:00Z",
              user: { login: "octocat", type: "User" },
            },
          ],
        ],
      ]),
    }),
    {
      pullRequestBody: pullRequestBody.replace(releaseBullet(), `${releaseBullet()} by @octocat`),
      changelogs: [
        {
          path: "packages/example/CHANGELOG.md",
          contents: changelog.replace(currentVersion, `${currentVersion} by @octocat`),
        },
      ],
      warnings: [],
    },
  );
});

void test("excludes bots and reports changes without a human PR author", () => {
  const botSha = "2222222222222222222222222222222222222222";
  const claudeSha = "3333333333333333333333333333333333333333";
  const missingAccountSha = "4444444444444444444444444444444444444444";
  const missingPullRequestSha = "5555555555555555555555555555555555555555";
  const pullRequestBody = [
    releaseBullet(botSha),
    releaseBullet(claudeSha),
    releaseBullet(missingAccountSha),
    releaseBullet(missingPullRequestSha),
  ].join("\n");

  assert.deepEqual(
    prepareReleaseContributors({
      pullRequestBody,
      changelogs: [],
      pullRequestsByCommit: new Map([
        [
          botSha,
          [
            {
              merge_commit_sha: botSha,
              merged_at: "2026-08-30T12:00:00Z",
              user: { login: "automation", type: "Bot" },
            },
          ],
        ],
        [
          claudeSha,
          [
            {
              merge_commit_sha: claudeSha,
              merged_at: "2026-08-30T12:00:00Z",
              user: { login: "claude[bot]", type: "User" },
            },
          ],
        ],
        [
          missingAccountSha,
          [{ merge_commit_sha: missingAccountSha, merged_at: "2026-08-30T12:00:00Z", user: null }],
        ],
        [missingPullRequestSha, []],
      ]),
    }),
    {
      pullRequestBody,
      changelogs: [],
      warnings: [
        `No GitHub account found for commit ${missingAccountSha}; leaving it unattributed.`,
        `No merged pull request found for commit ${missingPullRequestSha}; leaving it unattributed.`,
      ],
    },
  );
});

void test("does not duplicate existing attribution or change prose commit links", () => {
  const commitLink = `([${SHA.slice(0, 7)}](https://github.com/acme/toolkit/commit/${SHA}))`;
  const pullRequestBody = [
    `Implementation details: ${commitLink}`,
    `${releaseBullet()} by @octocat`,
  ].join("\n");

  assert.deepEqual(
    prepareReleaseContributors({
      pullRequestBody,
      changelogs: [],
      pullRequestsByCommit: new Map([
        [
          SHA,
          [
            {
              merge_commit_sha: SHA,
              merged_at: "2026-08-30T12:00:00Z",
              user: { login: "octocat", type: "User" },
            },
          ],
        ],
      ]),
    }),
    { pullRequestBody, changelogs: [], warnings: [] },
  );
});

void test("the CLI writes the complete prepared release contributor changes", async () => {
  const changelogPath = "packages/example/CHANGELOG.md";
  const bodyFile = "/tmp/release-pr-body.md";
  const pullRequestBody = releaseBullet();
  const changelog = ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n");
  const writes = [];
  const warnings = [];

  await runCli({
    argv: ["--repo", "acme/toolkit", "--pr", "42", "--body-file", bodyFile],
    env: { GH_TOKEN: "secret" },
    fetchImpl: async (url) => {
      const { pathname } = new URL(url);

      if (pathname.endsWith(`/commits/${SHA}/pulls`)) {
        return Response.json([
          {
            merge_commit_sha: SHA,
            merged_at: "2026-08-30T12:00:00Z",
            user: { login: "octocat", type: "User" },
          },
        ]);
      }
      if (pathname.endsWith("/pulls/42/files")) {
        return Response.json([{ filename: changelogPath }]);
      }
      return Response.json({ body: pullRequestBody });
    },
    readFile: async () => changelog,
    writeFile: async (...write) => writes.push(write),
    warn: (warning) => warnings.push(warning),
  });

  assert.deepEqual(
    { writes, warnings },
    {
      writes: [
        [bodyFile, `${releaseBullet()} by @octocat`, "utf8"],
        [changelogPath, `${changelog} by @octocat`, "utf8"],
      ],
      warnings: [],
    },
  );
});

void test("an API failure leaves the release body and changelog untouched", async () => {
  const changelogPath = "packages/example/CHANGELOG.md";
  const writes = [];
  let failure;

  try {
    await runCli({
      argv: ["--repo", "acme/toolkit", "--pr", "42", "--body-file", "/tmp/body.md"],
      env: { GH_TOKEN: "secret" },
      fetchImpl: async (url) => {
        const { pathname } = new URL(url);
        if (pathname.endsWith(`/commits/${SHA}/pulls`)) {
          return new Response("GitHub is unavailable", { status: 503 });
        }
        if (pathname.endsWith("/pulls/42/files")) {
          return Response.json([{ filename: changelogPath }]);
        }
        return Response.json({ body: releaseBullet() });
      },
      readFile: async () => ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n"),
      writeFile: async (...write) => writes.push(write),
      warn() {},
    });
  } catch (error) {
    failure = error;
  }

  assert.deepEqual(
    { message: failure?.message, writes },
    {
      message: `GitHub API GET /repos/acme/toolkit/commits/${SHA}/pulls?per_page=100 failed with 503: GitHub is unavailable`,
      writes: [],
    },
  );
});
