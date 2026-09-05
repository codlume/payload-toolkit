import assert from "node:assert/strict";
import { test } from "vitest";

import {
  loadReleaseContributorChanges,
  prepareReleaseContributors,
} from "../../src/release-contributors.ts";

const SHA = "abc123456789abc123456789abc123456789abcd";

function releaseBullet(sha = SHA) {
  return `* fix the preview ([#12](https://github.com/acme/toolkit/issues/12)) ([${sha.slice(0, 7)}](https://github.com/acme/toolkit/commit/${sha}))`;
}

test("credits a contributor in the release body and current changelog version", () => {
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

test("excludes bots and reports changes without a human PR author", () => {
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

test("does not duplicate existing attribution or change prose commit links", () => {
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

test("loads the body and every touched changelog, then credits both", async () => {
  const changelogPath = "packages/example/CHANGELOG.md";
  const changelog = ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n");

  const changes = await loadReleaseContributorChanges({
    repository: "acme/toolkit",
    pullRequestNumber: 42,
    github: {
      async getPullRequest() {
        return { body: releaseBullet() };
      },
      async listPullRequestFiles() {
        return [changelogPath, "packages/example/package.json"];
      },
      async listPullRequestsForCommit() {
        return [
          {
            merge_commit_sha: SHA,
            merged_at: "2026-08-30T12:00:00Z",
            user: { login: "octocat", type: "User" },
          },
        ];
      },
    },
    readFile: async () => changelog,
  });

  assert.deepEqual(changes, {
    pullRequestBody: `${releaseBullet()} by @octocat`,
    changelogs: [{ path: changelogPath, contents: `${changelog} by @octocat` }],
    warnings: [],
  });
});
