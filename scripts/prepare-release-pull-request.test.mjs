import assert from "node:assert/strict";
import test from "node:test";

import { prepareReleasePullRequest } from "./prepare-release-pull-request.mjs";

const HEAD = "1111111111111111111111111111111111111111";
const CHANGE_SHA = "2222222222222222222222222222222222222222";
const PREPARED_HEAD = "3333333333333333333333333333333333333333";

function releaseBullet() {
  return `* fix preview ([${CHANGE_SHA.slice(0, 7)}](https://github.com/acme/toolkit/commit/${CHANGE_SHA})) by @octocat`;
}

function preparedSystem() {
  const events = [];
  let bodyUpdated = false;
  let bodyVerified = false;
  const pullRequest = {
    headRef: "release-please--branches--main",
    headRepository: "acme/toolkit",
    headSha: HEAD,
    isDraft: true,
    number: 42,
  };
  const changelog = ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n");

  return {
    events,
    github: {
      async findOpenReleasePullRequests() {
        return [pullRequest];
      },
      async getPullRequest() {
        return { body: releaseBullet() };
      },
      async listPullRequestFiles() {
        return ["packages/example/CHANGELOG.md"];
      },
      async listPullRequestsForCommit() {
        return [
          {
            merge_commit_sha: CHANGE_SHA,
            merged_at: "2026-08-30T12:00:00Z",
            user: { login: "octocat", type: "User" },
          },
        ];
      },
      async markDraft() {
        events.push("draft");
      },
      async markReady() {
        assert.equal(bodyUpdated && bodyVerified, true);
        events.push("ready");
      },
      async observePullRequest() {
        if (bodyUpdated) bodyVerified = true;
        events.push("observe");
        return { headSha: HEAD, isDraft: !events.includes("ready"), state: "OPEN" };
      },
      async updatePullRequestBody(_repository, _number, body) {
        bodyUpdated = true;
        events.push(`body:${body}`);
      },
    },
    workingCopies: {
      async withExactHead(_pullRequest, prepare) {
        events.push("checkout");
        return prepare({
          async changedPaths() {
            return [];
          },
          async commit() {
            events.push("commit");
          },
          async hasStagedChanges() {
            return false;
          },
          async head() {
            return HEAD;
          },
          async push() {
            events.push("push");
          },
          async readFile() {
            return changelog;
          },
          async stageChangelogs() {
            events.push("stage");
          },
          async verifyStagedChanges() {
            events.push("verify");
          },
          async writeFile(_path, contents) {
            assert.equal(contents, changelog);
            events.push("write");
          },
        });
      },
    },
  };
}

void test("reports when there is no Release pull request to prepare", async () => {
  const result = await prepareReleasePullRequest(
    { repository: "acme/toolkit" },
    {
      github: {
        async findOpenReleasePullRequests() {
          return [];
        },
      },
    },
  );

  assert.deepEqual(result, { outcome: "no-release-pull-request" });
});

void test("rejects multiple open Release pull requests", async () => {
  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      {
        github: {
          async findOpenReleasePullRequests() {
            return [{ number: 41 }, { number: 42 }];
          },
        },
      },
    ),
    { message: "Found 2 open Release pull requests; expected at most one." },
  );
});

void test("rejects a Release pull request from another repository", async () => {
  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      {
        github: {
          async findOpenReleasePullRequests() {
            return [
              {
                headRepository: "someone/fork",
                headSha: "1111111111111111111111111111111111111111",
                isDraft: true,
                number: 42,
              },
            ];
          },
        },
      },
    ),
    { message: "Release pull request #42 head is not in acme/toolkit." },
  );
});

void test("rejects a Release pull request that is no longer a draft", async () => {
  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      {
        github: {
          async findOpenReleasePullRequests() {
            return [
              {
                headRepository: "acme/toolkit",
                headSha: "1111111111111111111111111111111111111111",
                isDraft: false,
                number: 42,
              },
            ];
          },
        },
      },
    ),
    { message: "Release pull request #42 is no longer an open draft." },
  );
});

void test("rejects a Release pull request with a malformed head", async () => {
  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      {
        github: {
          async findOpenReleasePullRequests() {
            return [
              {
                headRef: "release-please--branches--main",
                headRepository: "acme/toolkit",
                headSha: "not-a-commit",
                isDraft: true,
                number: 42,
              },
            ];
          },
        },
      },
    ),
    { message: "Release pull request #42 has an invalid head." },
  );
});

void test("readies an already-prepared Release pull request without a new commit", async () => {
  const system = preparedSystem();

  const result = await prepareReleasePullRequest(
    { repository: "acme/toolkit" },
    { github: system.github, workingCopies: system.workingCopies },
  );

  assert.deepEqual(result, {
    head: HEAD,
    outcome: "already-prepared",
    pullRequestNumber: 42,
  });
  assert.equal(system.events.includes("ready"), true);
  assert.equal(system.events.includes(`body:${releaseBullet()}`), true);
  assert.equal(system.events.includes("commit"), false);
  assert.equal(system.events.includes("push"), false);
});

void test("commits, pushes, and readies prepared changelogs and body", async () => {
  const system = preparedSystem();
  const uncreditedBullet = releaseBullet().replace(" by @octocat", "");
  const uncreditedChangelog = ["# Changelog", "", "## 1.1.0", "", uncreditedBullet].join("\n");
  system.workingCopies.withExactHead = async (_pullRequest, prepare) =>
    prepare({
      async changedPaths() {
        return ["packages/example/CHANGELOG.md"];
      },
      async commit() {
        system.events.push("commit");
      },
      async hasStagedChanges() {
        return true;
      },
      async head() {
        return PREPARED_HEAD;
      },
      async push(headRef, selectedHead) {
        assert.deepEqual(
          { headRef, selectedHead },
          {
            headRef: "release-please--branches--main",
            selectedHead: HEAD,
          },
        );
        system.events.push("push");
      },
      async readFile() {
        return uncreditedChangelog;
      },
      async stageChangelogs() {
        system.events.push("stage");
      },
      async verifyStagedChanges() {
        system.events.push("verify");
      },
      async writeFile(_path, contents) {
        assert.match(contents, /by @octocat/);
        system.events.push("write");
      },
    });
  system.github.getPullRequest = async () => ({ body: uncreditedBullet });
  system.github.observePullRequest = async () => {
    system.events.push("observe");
    return {
      headSha: PREPARED_HEAD,
      isDraft: !system.events.includes("ready"),
      state: "OPEN",
    };
  };
  system.github.markReady = async () => {
    system.events.push("ready");
  };

  const result = await prepareReleasePullRequest(
    { repository: "acme/toolkit" },
    { github: system.github, workingCopies: system.workingCopies },
  );

  assert.deepEqual(result, { head: PREPARED_HEAD, outcome: "prepared", pullRequestNumber: 42 });
  assert.equal(system.events.includes("commit"), true);
  assert.equal(system.events.includes("push"), true);
  assert.equal(system.events.includes(`body:${releaseBullet()}`), true);
  assert.equal(system.events.includes("ready"), true);
});

void test("rejects an unexpected file mutation before committing", async () => {
  const system = preparedSystem();
  let commitAttempted = false;
  system.workingCopies.withExactHead = async (_pullRequest, prepare) =>
    prepare({
      async changedPaths() {
        return ["README.md"];
      },
      async commit() {
        commitAttempted = true;
      },
      async readFile() {
        return ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n");
      },
      async writeFile() {},
    });

  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      { github: system.github, workingCopies: system.workingCopies },
    ),
    { message: "Release pull request preparation changed unexpected files:\nREADME.md" },
  );
  assert.equal(commitAttempted, false);
});

void test("leaves the Release pull request draft when pushing fails", async () => {
  const system = preparedSystem();
  let readyAttempted = false;
  system.github.markReady = async () => {
    readyAttempted = true;
  };
  system.workingCopies.withExactHead = async (_pullRequest, prepare) =>
    prepare({
      async changedPaths() {
        return ["packages/example/CHANGELOG.md"];
      },
      async commit() {},
      async hasStagedChanges() {
        return true;
      },
      async push() {
        throw new Error("push rejected");
      },
      async readFile() {
        return ["# Changelog", "", "## 1.1.0", "", releaseBullet()].join("\n");
      },
      async stageChangelogs() {},
      async verifyStagedChanges() {},
      async writeFile() {},
    });

  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      { github: system.github, workingCopies: system.workingCopies },
    ),
    { message: "push rejected" },
  );
  assert.equal(readyAttempted, false);
});

void test("does not ready the Release pull request when its body update fails", async () => {
  const system = preparedSystem();
  let readyAttempted = false;
  system.github.updatePullRequestBody = async () => {
    throw new Error("body update failed");
  };
  system.github.markReady = async () => {
    readyAttempted = true;
  };

  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      { github: system.github, workingCopies: system.workingCopies },
    ),
    { message: "body update failed" },
  );
  assert.equal(readyAttempted, false);
});

void test("reports a readiness failure without claiming success", async () => {
  const system = preparedSystem();
  let ready = false;
  system.github.markReady = async () => {
    ready = true;
    throw new Error("readiness failed");
  };
  system.github.markDraft = async () => {
    ready = false;
  };

  await assert.rejects(prepareReleasePullRequest({ repository: "acme/toolkit" }, system), {
    message: "readiness failed",
  });
  assert.equal(ready, false);
});

void test("does not ready a Release pull request that stops being a draft", async () => {
  const system = preparedSystem();
  let observations = 0;
  let readyAttempted = false;
  system.github.observePullRequest = async () => {
    observations += 1;
    return { headSha: HEAD, isDraft: observations === 1, state: "OPEN" };
  };
  system.github.markReady = async () => {
    readyAttempted = true;
  };

  await assert.rejects(prepareReleasePullRequest({ repository: "acme/toolkit" }, system), {
    message: "Release pull request is no longer an open draft.",
  });
  assert.equal(readyAttempted, false);
});

void test("does not ready a Release pull request changed by another writer", async () => {
  const system = preparedSystem();
  let readyAttempted = false;
  system.github.observePullRequest = async () => ({
    headSha: PREPARED_HEAD,
    isDraft: true,
    state: "OPEN",
  });
  system.github.markReady = async () => {
    readyAttempted = true;
  };

  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      { github: system.github, workingCopies: system.workingCopies },
    ),
    {
      message: `Release pull request moved to ${PREPARED_HEAD} while preparing ${HEAD}.`,
    },
  );
  assert.equal(readyAttempted, false);
});

void test("returns a concurrently changed Release pull request to draft after readiness", async () => {
  const system = preparedSystem();
  let observations = 0;
  system.github.observePullRequest = async () => {
    observations += 1;
    return {
      headSha: observations === 3 ? PREPARED_HEAD : HEAD,
      isDraft: observations < 3,
      state: "OPEN",
    };
  };
  system.github.markReady = async () => {
    system.events.push("ready");
  };

  await assert.rejects(
    prepareReleasePullRequest(
      { repository: "acme/toolkit" },
      { github: system.github, workingCopies: system.workingCopies },
    ),
    {
      message: `Release pull request moved to ${PREPARED_HEAD} while preparing ${HEAD}.`,
    },
  );
  assert.equal(system.events.at(-1), "draft");
});
