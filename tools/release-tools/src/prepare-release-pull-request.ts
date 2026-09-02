import { type ContributorSource, loadReleaseContributorChanges } from "./release-contributors.ts";

export type ReleasePullRequest = {
  body: string;
  headRef: string;
  headRepository: string | undefined;
  headSha: string;
  isDraft: boolean;
  number: number;
  state: string;
};

export type ObservedPullRequest = Pick<ReleasePullRequest, "headSha" | "isDraft" | "state">;

/** Everything preparation needs from GitHub; implemented by the GitHub adapter. */
export interface ReleaseGitHub extends ContributorSource {
  findOpenReleasePullRequests(repository: string): Promise<ReleasePullRequest[]>;
  observePullRequest(
    repository: string,
    number: number,
    headRef: string,
    expectedHead: string,
    expectedDraft: boolean,
  ): Promise<ObservedPullRequest>;
  updatePullRequestBody(repository: string, number: number, body: string): Promise<void>;
  markReady(repository: string, number: number): Promise<void>;
  markDraft(repository: string, number: number): Promise<void>;
}

/** A checkout of the Release pull request head that preparation may edit, commit, and push. */
export interface WorkingCopy {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<void>;
  changedPaths(): Promise<string[]>;
  stageChangelogs(): Promise<unknown>;
  hasStagedChanges(): Promise<boolean>;
  verifyStagedChanges(): Promise<unknown>;
  commit(): Promise<unknown>;
  push(headRef: string, selectedHead: string): Promise<unknown>;
  head(): Promise<string>;
}

export interface WorkingCopies {
  withExactHead<T>(
    pullRequest: Pick<ReleasePullRequest, "headRef" | "headSha">,
    prepare: (workingCopy: WorkingCopy) => Promise<T>,
  ): Promise<T>;
}

export type ReleaseAdapters = {
  github: ReleaseGitHub;
  reportWarning?: (warning: string) => void;
  workingCopies: WorkingCopies;
};

export type PreparationResult =
  | { outcome: "no-release-pull-request" }
  | { head: string; outcome: "prepared" | "already-prepared"; pullRequestNumber: number };

function assertObservedPullRequest(
  pullRequest: ObservedPullRequest,
  expectedHead: string,
  expectedDraft: boolean,
) {
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

/**
 * Release pull request preparation: credits contributors in the draft Release
 * pull request's changelogs and body, verifies the pull request still points
 * at the prepared commit, and only then marks it ready for review. Safe to
 * re-run; an already prepared pull request is readied without a new commit.
 */
export async function prepareReleasePullRequest(
  { repository }: { repository: string },
  { github, reportWarning = console.warn, workingCopies }: ReleaseAdapters,
): Promise<PreparationResult> {
  const pullRequests = await github.findOpenReleasePullRequests(repository);

  if (pullRequests.length > 1) {
    throw new Error(
      `Found ${pullRequests.length} open Release pull requests; expected at most one.`,
    );
  }

  const [pullRequest] = pullRequests;
  if (!pullRequest) {
    return { outcome: "no-release-pull-request" };
  }
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
