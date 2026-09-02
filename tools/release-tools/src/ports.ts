import type { ContributorSource } from "./release-contributors.ts";

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

export type MergedReleasePullRequest = {
  labels: string[];
  mergeCommitSha: string;
  number: number;
};

/** Everything the release commands need from GitHub; implemented by the GitHub adapter. */
export interface ReleaseGitHub extends ContributorSource {
  findOpenReleasePullRequests(repository: string): Promise<ReleasePullRequest[]>;
  findNewestMergedReleasePullRequest(
    repository: string,
  ): Promise<MergedReleasePullRequest | undefined>;
  pullRequestLabels(repository: string, number: number): Promise<string[]>;
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

/** The checked-out release commit's publishable packages. */
export interface Workspace {
  listPackageNames(): Promise<string[]>;
  /** Resolves to whether pnpm exited successfully; a version already on npm counts as success. */
  publish(name: string): Promise<boolean>;
}

export type ReleaseAdapters = {
  github: ReleaseGitHub;
  reportWarning?: (warning: string) => void;
  workingCopies: WorkingCopies;
};
