import { pathToFileURL } from "node:url";

import { createProductionAdapters } from "./prepare-release-pull-request-adapters.mjs";
import { loadReleaseContributorChanges } from "./release-contributors.mjs";

function assertObservedPullRequest(pullRequest, expectedHead, expectedDraft) {
  if (pullRequest.state !== "OPEN" || pullRequest.isDraft !== expectedDraft) {
    throw new Error(
      `Release pull request is no longer ${expectedDraft ? "an open draft" : "open and ready"}.`,
    );
  }
  if (pullRequest.headSha !== expectedHead) {
    throw new Error(
      `Release pull request moved to ${pullRequest.headSha} while preparing ${expectedHead}.`,
    );
  }
}

export async function prepareReleasePullRequest(
  { repository },
  { github, reportWarning = console.warn, workingCopies },
) {
  const pullRequests = await github.findOpenReleasePullRequests(repository);

  if (pullRequests.length === 0) {
    return { outcome: "no-release-pull-request" };
  }
  if (pullRequests.length > 1) {
    throw new Error(
      `Found ${pullRequests.length} open Release pull requests; expected at most one.`,
    );
  }

  const [pullRequest] = pullRequests;
  if (pullRequest.headRepository !== repository) {
    throw new Error(`Release pull request #${pullRequest.number} head is not in ${repository}.`);
  }
  if (!pullRequest.isDraft) {
    throw new Error(`Release pull request #${pullRequest.number} is no longer an open draft.`);
  }
  if (
    !pullRequest.headRef ||
    /\s/.test(pullRequest.headRef) ||
    !/^[0-9a-f]{40}$/i.test(pullRequest.headSha)
  ) {
    throw new Error(`Release pull request #${pullRequest.number} has an invalid head.`);
  }

  return workingCopies.withExactHead(pullRequest, async (workingCopy) => {
    const changes = await loadReleaseContributorChanges({
      repository,
      pullRequestNumber: pullRequest.number,
      github,
      readFile: (path, encoding) => workingCopy.readFile(path, encoding),
    });
    changes.warnings.forEach(reportWarning);

    await Promise.all(
      changes.changelogs.map(({ path, contents }) => workingCopy.writeFile(path, contents, "utf8")),
    );

    const unexpectedPaths = (await workingCopy.changedPaths()).filter(
      (path) => !/^packages\/[^/]+\/CHANGELOG\.md$/.test(path),
    );
    if (unexpectedPaths.length > 0) {
      throw new Error(
        `Release pull request preparation changed unexpected files:\n${unexpectedPaths.join("\n")}`,
      );
    }

    await workingCopy.stageChangelogs();
    const changed = await workingCopy.hasStagedChanges();
    if (changed) {
      await workingCopy.verifyStagedChanges();
      await workingCopy.commit();
      await workingCopy.push(pullRequest.headRef, pullRequest.headSha);
    }

    const expectedHead = await workingCopy.head();
    assertObservedPullRequest(
      await github.observePullRequest(
        repository,
        pullRequest.number,
        pullRequest.headRef,
        expectedHead,
        true,
      ),
      expectedHead,
      true,
    );
    await github.updatePullRequestBody(repository, pullRequest.number, changes.pullRequestBody);
    assertObservedPullRequest(
      await github.observePullRequest(
        repository,
        pullRequest.number,
        pullRequest.headRef,
        expectedHead,
        true,
      ),
      expectedHead,
      true,
    );
    try {
      await github.markReady(repository, pullRequest.number);
      assertObservedPullRequest(
        await github.observePullRequest(
          repository,
          pullRequest.number,
          pullRequest.headRef,
          expectedHead,
          false,
        ),
        expectedHead,
        false,
      );
    } catch (error) {
      await github.markDraft(repository, pullRequest.number);
      throw error;
    }

    return {
      head: expectedHead,
      outcome: changed ? "prepared" : "already-prepared",
      pullRequestNumber: pullRequest.number,
    };
  });
}

export async function runCli({ env = process.env, log = console.log } = {}) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Set GITHUB_REPOSITORY to owner/name.");
  }
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN.");

  const result = await prepareReleasePullRequest(
    { repository },
    createProductionAdapters({ repository, token }),
  );

  if (result.outcome === "no-release-pull-request") {
    log("No open Release pull request to prepare.");
  } else {
    log(
      `Release pull request #${result.pullRequestNumber} ${
        result.outcome === "prepared" ? "prepared at" : "already prepared at"
      } ${result.head}.`,
    );
  }

  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
