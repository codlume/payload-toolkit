import { readFile as readFileFromDisk, writeFile as writeFileToDisk } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const COMMIT_LINK =
  /\(\[[0-9a-f]{7,40}\]\(https:\/\/github\.com\/[^/]+\/[^/]+\/commit\/([0-9a-f]{7,40})\)\)(?=\s*$)/i;

function currentVersionSection(markdown) {
  let versionSection = 0;

  return markdown
    .split("\n")
    .filter((line) => {
      if (line.startsWith("## ")) versionSection += 1;
      return versionSection === 1;
    })
    .join("\n");
}

function commitShas(markdown) {
  return markdown
    .split("\n")
    .filter((line) => line.startsWith("* "))
    .flatMap((line) => {
      const match = line.match(COMMIT_LINK);
      return match ? [match[1]] : [];
    });
}

function enrichReleaseBullet(line, contributorsByCommit) {
  const match = line.match(COMMIT_LINK);
  const login = match && contributorsByCommit.get(match[1]);

  return login ? `${line} by @${login}` : line;
}

function enrichReleaseNotes(markdown, contributorsByCommit) {
  return markdown
    .split("\n")
    .map((line) => {
      if (!line.startsWith("* ")) return line;
      return enrichReleaseBullet(line, contributorsByCommit);
    })
    .join("\n");
}

function enrichCurrentVersion(changelog, contributorsByCommit) {
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

export function prepareReleaseContributors({ pullRequestBody, changelogs, pullRequestsByCommit }) {
  const warnings = [];
  const contributorsByCommit = new Map();

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

    const { user } = mergedPullRequest;
    if (!user?.login) {
      warnings.push(`No GitHub account found for commit ${sha}; leaving it unattributed.`);
      continue;
    }

    if (user.type === "Bot" || user.login.toLowerCase().endsWith("[bot]")) continue;
    contributorsByCommit.set(sha, user.login);
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

async function loadReleaseContributorChanges({ repository, pullRequestNumber, github, readFile }) {
  const [pullRequest, changedFiles] = await Promise.all([
    github.getPullRequest(repository, pullRequestNumber),
    github.listPullRequestFiles(repository, pullRequestNumber),
  ]);
  const changelogPaths = changedFiles.filter((path) => /(^|\/)CHANGELOG\.md$/.test(path));
  const changelogs = await Promise.all(
    changelogPaths.map(async (path) => ({ path, contents: await readFile(path, "utf8") })),
  );
  const shas = new Set(commitShas(pullRequest.body ?? ""));

  for (const { contents } of changelogs) {
    for (const sha of commitShas(currentVersionSection(contents))) shas.add(sha);
  }

  const pullRequestEntries = await Promise.all(
    [...shas].map(async (sha) => {
      const associatedPullRequests = await github.listPullRequestsForCommit(repository, sha);
      return [sha, associatedPullRequests];
    }),
  );

  return prepareReleaseContributors({
    pullRequestBody: pullRequest.body ?? "",
    changelogs,
    pullRequestsByCommit: new Map(pullRequestEntries),
  });
}

function cliOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return argv[index + 1];
}

function createGitHubClient({ token, fetchImpl }) {
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `GitHub API GET ${path} failed with ${response.status}${details ? `: ${details}` : "."}`,
      );
    }

    return response.json();
  }

  return {
    async getPullRequest(repository, pullRequestNumber) {
      return get(`/repos/${repository}/pulls/${pullRequestNumber}`);
    },
    async listPullRequestFiles(repository, pullRequestNumber) {
      async function listPage(page) {
        const files = await get(
          `/repos/${repository}/pulls/${pullRequestNumber}/files?per_page=100&page=${page}`,
        );
        const filenames = files.map(({ filename }) => filename);

        return files.length < 100 ? filenames : filenames.concat(await listPage(page + 1));
      }

      return listPage(1);
    },
    async listPullRequestsForCommit(repository, sha) {
      return get(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
    },
  };
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  readFile = readFileFromDisk,
  writeFile = writeFileToDisk,
  warn = console.warn,
} = {}) {
  const repository = cliOption(argv, "--repo") ?? env.GITHUB_REPOSITORY;
  const pullRequest = cliOption(argv, "--pr") ?? env.RELEASE_PULL_REQUEST_NUMBER;
  const bodyFile = cliOption(argv, "--body-file") ?? env.RELEASE_PULL_REQUEST_BODY_FILE;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;
  const pullRequestNumber = Number(pullRequest);

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Pass --repo owner/name or set GITHUB_REPOSITORY.");
  }
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error(
      "Pass --pr with a positive pull request number or set RELEASE_PULL_REQUEST_NUMBER.",
    );
  }
  if (!bodyFile) {
    throw new Error("Pass --body-file or set RELEASE_PULL_REQUEST_BODY_FILE.");
  }
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN for GitHub API access.");

  const changes = await loadReleaseContributorChanges({
    repository,
    pullRequestNumber,
    github: createGitHubClient({ token, fetchImpl }),
    readFile,
  });

  for (const warning of changes.warnings) warn(warning);
  await Promise.all([
    writeFile(bodyFile, changes.pullRequestBody, "utf8"),
    ...changes.changelogs.map(({ path, contents }) => writeFile(path, contents, "utf8")),
  ]);

  return changes;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
