import { execFile as execFileWithCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileFromSystem = promisify(execFileWithCallback);
const API_ROOT = "https://api.github.com";
const MAX_HEAD_READS = 10;
const HEAD_RETRY_DELAY_MS = 1_000;

function splitRepository(repository) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, name };
}

function normalizePullRequest(pullRequest) {
  const headRepository =
    pullRequest.headRepository?.nameWithOwner ?? pullRequest.head?.repo?.full_name;

  return {
    body: pullRequest.body ?? "",
    headRef: pullRequest.headRefName ?? pullRequest.head?.ref,
    headRepository,
    headSha: pullRequest.headRefOid ?? pullRequest.head?.sha,
    id: pullRequest.id ?? pullRequest.node_id,
    isDraft: pullRequest.isDraft ?? pullRequest.draft,
    number: pullRequest.number,
    state: pullRequest.state?.toUpperCase(),
  };
}

export function createGitHubAdapter({
  token,
  fetchImpl = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!token) throw new Error("A GitHub token is required.");
  const initialHeads = new Map();

  async function request(path, options = {}) {
    const response = await fetchImpl(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `GitHub API ${options.method ?? "GET"} ${path} failed with ${response.status}${details ? `: ${details}` : "."}`,
      );
    }
    if (response.status === 204) return undefined;
    return response.json();
  }

  async function graphql(query, variables) {
    const result = await request("/graphql", {
      body: JSON.stringify({ query, variables }),
      method: "POST",
    });
    if (result.errors?.length) {
      throw new Error(
        `GitHub GraphQL failed: ${result.errors.map(({ message }) => message).join("; ")}`,
      );
    }
    return result.data;
  }

  async function pullRequest(repository, number) {
    return request(`/repos/${repository}/pulls/${number}`);
  }

  async function repositoryHead(repository, headRef) {
    const ref = await request(`/repos/${repository}/git/ref/heads/${encodeURIComponent(headRef)}`);
    return ref.object.sha;
  }

  async function pullRequestId(repository, number) {
    const pull = await pullRequest(repository, number);
    return pull.node_id;
  }

  return {
    async findOpenReleasePullRequests(repository) {
      const { owner, name } = splitRepository(repository);
      const data = await graphql(
        `
          query ReleasePullRequests($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
              pullRequests(
                first: 10
                states: OPEN
                baseRefName: "main"
                labels: ["autorelease: pending"]
              ) {
                nodes {
                  id
                  number
                  body
                  state
                  isDraft
                  headRefName
                  headRefOid
                  headRepository {
                    nameWithOwner
                  }
                }
              }
            }
          }
        `,
        { owner, name },
      );
      const pulls = data.repository.pullRequests.nodes.map((pull) => normalizePullRequest(pull));
      for (const pull of pulls) initialHeads.set(`${repository}#${pull.number}`, pull.headSha);
      return pulls;
    },

    getPullRequest: pullRequest,

    async listPullRequestFiles(repository, number) {
      async function listPage(page) {
        const files = await request(
          `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        const paths = files.map(({ filename }) => filename);
        return files.length < 100 ? paths : paths.concat(await listPage(page + 1));
      }
      return listPage(1);
    },

    listPullRequestsForCommit(repository, sha) {
      return request(`/repos/${repository}/commits/${sha}/pulls?per_page=100`);
    },

    async observePullRequest(repository, number, headRef, expectedHead, expectedDraft) {
      const previousHead = initialHeads.get(`${repository}#${number}`);
      async function observe(read) {
        const [pull, currentHead] = await Promise.all([
          pullRequest(repository, number),
          repositoryHead(repository, headRef),
        ]);
        const observed = normalizePullRequest(pull);
        if (currentHead !== expectedHead && currentHead !== previousHead) {
          return { ...observed, headSha: currentHead };
        }
        const headMatches = currentHead === expectedHead && observed.headSha === expectedHead;
        if (
          headMatches &&
          (observed.state !== "OPEN" || observed.isDraft === expectedDraft || expectedDraft)
        ) {
          return observed;
        }
        if (read === MAX_HEAD_READS) return { ...observed, headSha: currentHead };
        await wait(HEAD_RETRY_DELAY_MS);
        return observe(read + 1);
      }
      return observe(1);
    },

    async updatePullRequestBody(repository, number, body) {
      await request(`/repos/${repository}/pulls/${number}`, {
        body: JSON.stringify({ body }),
        method: "PATCH",
      });
    },

    async markReady(repository, number) {
      const pullRequestIdValue = await pullRequestId(repository, number);
      await graphql(
        `
          mutation MarkReady($id: ID!) {
            markPullRequestReadyForReview(input: { pullRequestId: $id }) {
              pullRequest {
                id
              }
            }
          }
        `,
        { id: pullRequestIdValue },
      );
    },

    async markDraft(repository, number) {
      const pullRequestIdValue = await pullRequestId(repository, number);
      await graphql(
        `
          mutation MarkDraft($id: ID!) {
            convertPullRequestToDraft(input: { pullRequestId: $id }) {
              pullRequest {
                id
              }
            }
          }
        `,
        { id: pullRequestIdValue },
      );
    },
  };
}

function changedPathsFromPorcelain(output) {
  const records = output.toString().split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const status = record.slice(0, 2);
    paths.push(record.slice(3));
    const statusCodes = new Set(status);
    if (statusCodes.has("R") || statusCodes.has("C")) {
      const source = records[index + 1];
      if (source) paths.push(source);
      index += 1;
    }
  }
  return paths;
}

export function createWorkingCopiesAdapter({
  repository,
  token,
  execFile = execFileFromSystem,
  fs = { mkdtemp, readFile, rm, writeFile },
  temporaryDirectory = tmpdir(),
} = {}) {
  if (!repository) throw new Error("A GitHub repository is required.");
  if (!token) throw new Error("A GitHub token is required.");

  const authentication = Buffer.from(`x-access-token:${token}`).toString("base64");
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authentication}`,
    GIT_TERMINAL_PROMPT: "0",
  };

  return {
    async withExactHead(pullRequestValue, prepare) {
      const directory = await fs.mkdtemp(join(temporaryDirectory, "release-pull-request-"));
      const remote = `https://github.com/${repository}.git`;
      const git = async (args, options = {}) =>
        execFile("git", args, { cwd: directory, env: gitEnv, ...options });

      try {
        await git(["init", "--quiet"]);
        await git(["fetch", "--no-tags", "--depth=1", remote, pullRequestValue.headSha]);
        await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);

        return await prepare({
          readFile: (path, encoding) => fs.readFile(join(directory, path), encoding),
          writeFile: (path, contents, encoding) =>
            fs.writeFile(join(directory, path), contents, encoding),
          async changedPaths() {
            const { stdout } = await git([
              "status",
              "--porcelain=v1",
              "-z",
              "--untracked-files=all",
            ]);
            return changedPathsFromPorcelain(stdout);
          },
          stageChangelogs: () => git(["add", "--", ":(glob)packages/*/CHANGELOG.md"]),
          async hasStagedChanges() {
            try {
              await git(["diff", "--cached", "--quiet"]);
              return false;
            } catch (error) {
              if (error.code === 1) return true;
              throw error;
            }
          },
          verifyStagedChanges: () => git(["diff", "--cached", "--check"]),
          commit: () =>
            git([
              "-c",
              "user.name=github-actions[bot]",
              "-c",
              "user.email=41898282+github-actions[bot]@users.noreply.github.com",
              "commit",
              "-m",
              "chore(release): credit contributors",
            ]),
          push: (headRef, selectedHead) =>
            git([
              "push",
              `--force-with-lease=refs/heads/${headRef}:${selectedHead}`,
              remote,
              `HEAD:refs/heads/${headRef}`,
            ]),
          async head() {
            const { stdout } = await git(["rev-parse", "HEAD"]);
            return stdout.trim();
          },
        });
      } finally {
        await fs.rm(directory, { force: true, recursive: true });
      }
    },
  };
}

export function createProductionAdapters(options) {
  return {
    github: createGitHubAdapter(options),
    reportWarning: console.warn,
    workingCopies: createWorkingCopiesAdapter(options),
  };
}
