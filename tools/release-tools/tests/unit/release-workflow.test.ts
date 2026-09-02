import assert from "node:assert/strict";
import { test } from "vitest";

import type { ReleaseGitHub, ReleasePullRequest, Workspace } from "../../src/ports.ts";
import {
  findReleaseCommit,
  holdReleasePullRequestDraft,
  publishPackages,
  verifyReleasePullRequestTagged,
} from "../../src/release-workflow.ts";

const SHA = "1111111111111111111111111111111111111111";

function unexpected(name: string) {
  return async (): Promise<never> => {
    throw new Error(`Unexpected ${name} call.`);
  };
}

function githubStub(overrides: Partial<ReleaseGitHub>): ReleaseGitHub {
  return {
    findNewestMergedReleasePullRequest: unexpected("findNewestMergedReleasePullRequest"),
    findOpenReleasePullRequests: unexpected("findOpenReleasePullRequests"),
    getPullRequest: unexpected("getPullRequest"),
    listPullRequestFiles: unexpected("listPullRequestFiles"),
    listPullRequestsForCommit: unexpected("listPullRequestsForCommit"),
    markDraft: unexpected("markDraft"),
    markReady: unexpected("markReady"),
    observePullRequest: unexpected("observePullRequest"),
    pullRequestLabels: unexpected("pullRequestLabels"),
    updatePullRequestBody: unexpected("updatePullRequestBody"),
    ...overrides,
  };
}

function releasePullRequest(overrides: Partial<ReleasePullRequest> = {}): ReleasePullRequest {
  return {
    body: "",
    headRef: "release-please--branches--main",
    headRepository: "acme/toolkit",
    headSha: SHA,
    isDraft: true,
    number: 42,
    state: "OPEN",
    ...overrides,
  };
}

test("holding finds nothing when no Release pull request is open", async () => {
  const result = await holdReleasePullRequestDraft(
    { repository: "acme/toolkit" },
    {
      github: githubStub({
        async findOpenReleasePullRequests() {
          return [];
        },
      }),
    },
  );

  assert.deepEqual(result, { outcome: "no-release-pull-request" });
});

test("holding rejects multiple open Release pull requests", async () => {
  await assert.rejects(
    holdReleasePullRequestDraft(
      { repository: "acme/toolkit" },
      {
        github: githubStub({
          async findOpenReleasePullRequests() {
            return [releasePullRequest({ number: 41 }), releasePullRequest({ number: 42 })];
          },
        }),
      },
    ),
    { message: "Found 2 open Release pull requests; expected at most one." },
  );
});

test("holding leaves a draft Release pull request alone", async () => {
  const result = await holdReleasePullRequestDraft(
    { repository: "acme/toolkit" },
    {
      github: githubStub({
        async findOpenReleasePullRequests() {
          return [releasePullRequest()];
        },
      }),
    },
  );

  assert.deepEqual(result, { outcome: "already-draft", pullRequestNumber: 42 });
});

test("holding moves a ready Release pull request back to draft", async () => {
  const drafted: number[] = [];
  const result = await holdReleasePullRequestDraft(
    { repository: "acme/toolkit" },
    {
      github: githubStub({
        async findOpenReleasePullRequests() {
          return [releasePullRequest({ isDraft: false })];
        },
        async markDraft(_repository, number) {
          drafted.push(number);
        },
      }),
    },
  );

  assert.deepEqual(
    { drafted, result },
    {
      drafted: [42],
      result: { outcome: "held", pullRequestNumber: 42 },
    },
  );
});

function mergedGithub(labels: string[] | undefined) {
  return githubStub({
    async findNewestMergedReleasePullRequest() {
      return labels && { labels, mergeCommitSha: SHA, number: 7 };
    },
  });
}

test("finds nothing to release when no Release pull request has merged", async () => {
  const result = await findReleaseCommit(
    { repository: "acme/toolkit", runAttempt: 1 },
    { github: mergedGithub(undefined) },
  );

  assert.deepEqual(result.outputs, { number: "", pending: "", sha: "" });
});

test("finds a pending Release pull request's merge commit", async () => {
  const result = await findReleaseCommit(
    { repository: "acme/toolkit", runAttempt: 1 },
    { github: mergedGithub(["autorelease: pending"]) },
  );

  assert.deepEqual(result.outputs, { number: "7", pending: "true", sha: SHA });
});

test("leaves a tagged Release pull request alone on an ordinary run", async () => {
  const result = await findReleaseCommit(
    { repository: "acme/toolkit", runAttempt: 1 },
    { github: mergedGithub(["autorelease: tagged"]) },
  );

  assert.deepEqual(result.outputs, { number: "7", pending: "", sha: "" });
});

test("re-runs publish a tagged Release pull request's merge commit", async () => {
  const result = await findReleaseCommit(
    { repository: "acme/toolkit", runAttempt: 2 },
    { github: mergedGithub(["autorelease: tagged"]) },
  );

  assert.deepEqual(result.outputs, { number: "7", pending: "false", sha: SHA });
});

test("accepts a tagged Release pull request", async () => {
  await verifyReleasePullRequestTagged(
    { repository: "acme/toolkit", pullRequestNumber: 7 },
    {
      github: githubStub({
        async pullRequestLabels() {
          return ["autorelease: tagged"];
        },
      }),
    },
  );
});

test("rejects a Release pull request release-please did not tag, with retitle guidance", async () => {
  await assert.rejects(
    verifyReleasePullRequestTagged(
      { repository: "acme/toolkit", pullRequestNumber: 7 },
      {
        github: githubStub({
          async pullRequestLabels() {
            return ["autorelease: pending"];
          },
        }),
      },
    ),
    /no GitHub Release for Release pull request #7;.*retitle the merged pull request/,
  );
});

function workspaceOf(results: Record<string, boolean>) {
  const attempted: string[] = [];
  const workspace: Workspace = {
    async listPackageNames() {
      return Object.keys(results);
    },
    async publish(name) {
      attempted.push(name);
      return results[name] ?? false;
    },
  };
  return { attempted, workspace };
}

test("publishes every package and reports each one", async () => {
  const logs: string[] = [];
  const { workspace } = workspaceOf({ "@acme/a": true, "@acme/b": true });

  const result = await publishPackages({ log: (message) => logs.push(message), workspace });

  assert.deepEqual(
    { logs, result },
    {
      logs: ["Published (or already on npm): @acme/a", "Published (or already on npm): @acme/b"],
      result: { published: ["@acme/a", "@acme/b"] },
    },
  );
});

test("one failed publish does not block the others but fails the run", async () => {
  const { attempted, workspace } = workspaceOf({ "@acme/a": false, "@acme/b": true });

  await assert.rejects(publishPackages({ log() {}, workspace }), {
    message: "Publish failed for: @acme/a",
  });
  assert.deepEqual(attempted, ["@acme/a", "@acme/b"]);
});
