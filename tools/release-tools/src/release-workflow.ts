import type { ReleaseGitHub, Workspace } from "./ports.ts";

const PENDING = "autorelease: pending";
const TAGGED = "autorelease: tagged";

/**
 * Moves an open Release pull request back to draft before release-please
 * refreshes it, so a maintainer cannot merge changelogs that have not been
 * credited yet. Existing pull requests may predate draft-by-default.
 */
export async function holdReleasePullRequestDraft(
  { repository }: { repository: string },
  { github }: { github: ReleaseGitHub },
): Promise<
  | { outcome: "no-release-pull-request" }
  | { outcome: "already-draft" | "held"; pullRequestNumber: number }
> {
  const pullRequests = await github.findOpenReleasePullRequests(repository);
  if (pullRequests.length > 1) {
    throw new Error(
      `Found ${pullRequests.length} open Release pull requests; expected at most one.`,
    );
  }

  const [pullRequest] = pullRequests;
  if (!pullRequest) return { outcome: "no-release-pull-request" };
  if (pullRequest.isDraft) {
    return { outcome: "already-draft", pullRequestNumber: pullRequest.number };
  }

  await github.markDraft(repository, pullRequest.number);
  return { outcome: "held", pullRequestNumber: pullRequest.number };
}

export type ReleaseCommitSearch = {
  message: string;
  /** Workflow outputs; empty strings mean the rest of the run has nothing to release. */
  outputs: { number: string; pending: string; sha: string };
};

/**
 * Names the only commit the rest of the Release run may act on: the merge
 * commit of the newest merged Release pull request. A pending pull request
 * still needs its GitHub Releases and npm publish. A tagged one needs at most
 * the npm publish, and only a re-run attempts it, so an ordinary push after a
 * finished release finds nothing to do.
 */
export async function findReleaseCommit(
  { repository, runAttempt }: { repository: string; runAttempt: number },
  { github }: { github: ReleaseGitHub },
): Promise<ReleaseCommitSearch> {
  const merged = await github.findNewestMergedReleasePullRequest(repository);
  if (!merged) {
    return {
      message: "Nothing to release: no Release pull request has been merged.",
      outputs: { number: "", pending: "", sha: "" },
    };
  }

  const number = String(merged.number);
  if (merged.labels.includes(PENDING)) {
    return {
      message: `Release commit: ${merged.mergeCommitSha} (Release pull request #${number} awaits its GitHub Releases and npm publish)`,
      outputs: { number, pending: "true", sha: merged.mergeCommitSha },
    };
  }
  if (runAttempt > 1) {
    return {
      message: `Release commit: ${merged.mergeCommitSha} (re-run; Release pull request #${number} is tagged, publishing whatever npm still lacks)`,
      outputs: { number, pending: "false", sha: merged.mergeCommitSha },
    };
  }
  return {
    message: `Nothing to release: the newest Release pull request #${number} is already tagged.`,
    outputs: { number, pending: "", sha: "" },
  };
}

/**
 * Release-please exits successfully when it releases nothing, for example when
 * the merged pull request's title no longer matches its configured pattern.
 * Its relabel to tagged is the proof that every plugin has its tag and GitHub
 * Release; nothing reaches npm without it.
 */
export async function verifyReleasePullRequestTagged(
  { repository, pullRequestNumber }: { repository: string; pullRequestNumber: number },
  { github }: { github: ReleaseGitHub },
): Promise<void> {
  const labels = await github.pullRequestLabels(repository, pullRequestNumber);
  if (labels.includes(TAGGED)) return;
  throw new Error(
    `release-please created no GitHub Release for Release pull request #${pullRequestNumber}; see its log above. If it reported a bad pull request title, retitle the merged pull request to match group-pull-request-title-pattern in release-please-config.json, then re-run the failed jobs.`,
  );
}

/**
 * Publishes every package one at a time so one failure does not block the
 * others, then fails if any did. pnpm skips versions already on npm and
 * private packages, which is what makes a re-run safe.
 */
export async function publishPackages({
  log,
  workspace,
}: {
  log: (message: string) => void;
  workspace: Workspace;
}): Promise<{ published: string[] }> {
  const published: string[] = [];
  const failed: string[] = [];

  async function publishInOrder(names: string[]): Promise<void> {
    const [name, ...rest] = names;
    if (name === undefined) return;
    if (await workspace.publish(name)) {
      published.push(name);
      log(`Published (or already on npm): ${name}`);
    } else {
      failed.push(name);
    }
    return publishInOrder(rest);
  }

  await publishInOrder(await workspace.listPackageNames());
  if (failed.length > 0) throw new Error(`Publish failed for: ${failed.join(", ")}`);
  return { published };
}
