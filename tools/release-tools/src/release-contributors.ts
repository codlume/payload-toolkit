const COMMIT_LINK =
  /\(\[[0-9a-f]{7,40}\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7,40})\)\)(?=\s*$)/i;

export type AssociatedPullRequest = {
  merge_commit_sha?: string | null;
  merged_at?: string | null;
  user?: { login?: string | null; type?: string | null } | null;
};

export type Changelog = { path: string; contents: string };

export type ReleaseContributorChanges = {
  pullRequestBody: string;
  changelogs: Changelog[];
  warnings: string[];
};

/** The GitHub reads contributor attribution needs; implemented by the GitHub adapter. */
export interface ContributorSource {
  getPullRequest(repository: string, number: number): Promise<{ body?: string | null }>;
  listPullRequestFiles(repository: string, number: number): Promise<string[]>;
  listPullRequestsForCommit(repository: string, sha: string): Promise<AssociatedPullRequest[]>;
}

function currentVersionSection(markdown: string) {
  let versionSection = 0;

  return markdown
    .split("\n")
    .filter((line) => {
      if (line.startsWith("## ")) versionSection += 1;
      return versionSection === 1;
    })
    .join("\n");
}

function commitShas(markdown: string) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("* "))
    .flatMap((line) => {
      const sha = line.match(COMMIT_LINK)?.[1];
      return sha ? [sha] : [];
    });
}

function enrichReleaseBullet(line: string, contributorsByCommit: Map<string, string>) {
  const sha = line.match(COMMIT_LINK)?.[1];
  const login = sha && contributorsByCommit.get(sha);

  return login ? `${line} by @${login}` : line;
}

function enrichReleaseNotes(markdown: string, contributorsByCommit: Map<string, string>) {
  return markdown
    .split("\n")
    .map((line) => {
      if (!line.startsWith("* ")) return line;
      return enrichReleaseBullet(line, contributorsByCommit);
    })
    .join("\n");
}

function enrichCurrentVersion(changelog: string, contributorsByCommit: Map<string, string>) {
  let versionSection = 0;

  return changelog
    .split("\n")
    .map((line) => {
      if (line.startsWith("## ")) versionSection += 1;
      if (versionSection !== 1 || !line.startsWith("* ")) return line;
      return enrichReleaseBullet(line, contributorsByCommit);
    })
    .join("\n");
}

/**
 * Appends `by @login` to each release bullet whose commit came from a merged
 * pull request with a human author. Bullets from bots, unresolved accounts, or
 * direct commits stay as they are and produce a warning.
 */
export function prepareReleaseContributors({
  pullRequestBody,
  changelogs,
  pullRequestsByCommit,
}: {
  pullRequestBody: string;
  changelogs: Changelog[];
  pullRequestsByCommit: Map<string, AssociatedPullRequest[]>;
}): ReleaseContributorChanges {
  const warnings: string[] = [];
  const contributorsByCommit = new Map<string, string>();

  for (const [sha, associatedPullRequests] of pullRequestsByCommit) {
    const mergedPullRequest =
      associatedPullRequests.find(
        ({ merge_commit_sha, merged_at }) =>
          merged_at && merge_commit_sha?.toLowerCase() === sha.toLowerCase(),
      ) ?? associatedPullRequests.find(({ merged_at }) => merged_at);

    if (!mergedPullRequest) {
      warnings.push(`No merged pull request found for commit ${sha}; leaving it unattributed.`);
      continue;
    }

    const login = mergedPullRequest.user?.login;
    if (!login) {
      warnings.push(`No GitHub account found for commit ${sha}; leaving it unattributed.`);
      continue;
    }

    if (mergedPullRequest.user?.type === "Bot" || login.toLowerCase().endsWith("[bot]")) continue;
    contributorsByCommit.set(sha, login);
  }

  return {
    pullRequestBody: enrichReleaseNotes(pullRequestBody, contributorsByCommit),
    changelogs: changelogs.map(({ path, contents }) => ({
      path,
      contents: enrichCurrentVersion(contents, contributorsByCommit),
    })),
    warnings,
  };
}

/**
 * Reads the Release pull request body and the changelogs it touches, resolves
 * every referenced commit to its merged pull request, and returns the credited
 * text. Nothing is written; the caller decides what to do with the changes.
 */
export async function loadReleaseContributorChanges({
  repository,
  pullRequestNumber,
  github,
  readFile,
}: {
  repository: string;
  pullRequestNumber: number;
  github: ContributorSource;
  readFile: (path: string, encoding: "utf8") => Promise<string>;
}): Promise<ReleaseContributorChanges> {
  const [pullRequest, changedFiles] = await Promise.all([
    github.getPullRequest(repository, pullRequestNumber),
    github.listPullRequestFiles(repository, pullRequestNumber),
  ]);
  const changelogPaths = changedFiles.filter((path) => /(^|\/)CHANGELOG\.md$/.test(path));
  const changelogs = await Promise.all(
    changelogPaths.map(async (path) => ({ path, contents: await readFile(path, "utf8") })),
  );
  const pullRequestBody = pullRequest.body ?? "";
  const shas = new Set(commitShas(pullRequestBody));

  for (const { contents } of changelogs) {
    for (const sha of commitShas(currentVersionSection(contents))) shas.add(sha);
  }

  const pullRequestEntries = await Promise.all(
    [...shas].map(async (sha): Promise<[string, AssociatedPullRequest[]]> => {
      const associatedPullRequests = await github.listPullRequestsForCommit(repository, sha);
      return [sha, associatedPullRequests];
    }),
  );

  return prepareReleaseContributors({
    pullRequestBody,
    changelogs,
    pullRequestsByCommit: new Map(pullRequestEntries),
  });
}
