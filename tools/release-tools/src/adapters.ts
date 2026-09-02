import { execFile as execFileWithCallback, spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type {
  MergedReleasePullRequest,
  ReleaseAdapters,
  ReleaseGitHub,
  ReleasePullRequest,
  WorkingCopies,
  WorkingCopy,
  Workspace,
} from "./ports.ts";
import type { AssociatedPullRequest } from "./release-contributors.ts";

const API_ROOT = "https://api.github.com";
const MAX_HEAD_READS = 10;
const HEAD_RETRY_DELAY_MS = 1_000;

type GraphqlPullRequest = {
  body: string | null;
  headRefName: string;
  headRefOid: string;
  headRepository: { nameWithOwner: string } | null;
  isDraft: boolean;
  number: number;
  state: string;
};

type RestPullRequest = {
  body: string | null;
  draft: boolean;
  head: { ref: string; repo: { full_name: string } | null; sha: string };
  labels: { name: string }[];
  node_id: string;
  number: number;
  state: string;
};

type MergedGraphqlPullRequest = {
  labels: { nodes: { name: string }[] };
  mergeCommit: { oid: string } | null;
  number: number;
};

function splitRepository(repository: string) {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error(`Invalid GitHub repository: ${repository}`);
  return { owner, name };
}

function fromGraphql(pullRequest: GraphqlPullRequest): ReleasePullRequest {
  return {
    body: pullRequest.body ?? "",
    headRef: pullRequest.headRefName,
    headRepository: pullRequest.headRepository?.nameWithOwner,
    headSha: pullRequest.headRefOid,
    isDraft: pullRequest.isDraft,
    number: pullRequest.number,
    state: pullRequest.state.toUpperCase(),
  };
}

function fromRest(pullRequest: RestPullRequest): ReleasePullRequest {
  return {
    body: pullRequest.body ?? "",
    headRef: pullRequest.head.ref,
    headRepository: pullRequest.head.repo?.full_name,
    headSha: pullRequest.head.sha,
    isDraft: pullRequest.draft,
    number: pullRequest.number,
    state: pullRequest.state.toUpperCase(),
  };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

// GitHub's response shapes are trusted here; the API is the boundary this
// package exists to wrap, and the callers name the shape they expect.
function decodeJson<T>(response: Response): Promise<T> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return response.json() as Promise<T>;
}

/**
 * GitHub over REST and GraphQL with a token. `fetchImpl` and `wait` exist so
 * tests can script responses and skip real delays.
 */
export function createGitHubAdapter({
  token,
  fetchImpl = globalThis.fetch,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}: {
  token: string;
  fetchImpl?: FetchImpl;
  wait?: (milliseconds: number) => Promise<unknown>;
}): ReleaseGitHub {
  if (!token) throw new Error("A GitHub token is required.");
  const initialHeads = new Map<string, string>();

  async function request<T>(
    path: string,
    options: { body?: string; method?: "PATCH" | "POST" } = {},
  ): Promise<T> {
    const response = await fetchImpl(`${API_ROOT}${path}`, {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(
        `GitHub API ${options.method ?? "GET"} ${path} failed with ${response.status}${details ? `: ${details}` : "."}`,
      );
    }
    return decodeJson<T>(response);
  }

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const result = await request<{ data: T; errors?: { message: string }[] }>("/graphql", {
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

  function pullRequest(repository: string, number: number) {
    return request<RestPullRequest>(`/repos/${repository}/pulls/${number}`);
  }

  async function repositoryHead(repository: string, headRef: string) {
    const ref = await request<{ object: { sha: string } }>(
      `/repos/${repository}/git/ref/heads/${encodeURIComponent(headRef)}`,
    );
    return ref.object.sha;
  }

  async function pullRequestId(repository: string, number: number) {
    const pull = await pullRequest(repository, number);
    return pull.node_id;
  }

  return {
    async findOpenReleasePullRequests(repository) {
      const { owner, name } = splitRepository(repository);
      const data = await graphql<{
        repository: { pullRequests: { nodes: GraphqlPullRequest[] } };
      }>(
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
      const pulls = data.repository.pullRequests.nodes.map((pull) => fromGraphql(pull));
      for (const pull of pulls) initialHeads.set(`${repository}#${pull.number}`, pull.headSha);
      return pulls;
    },

    async findNewestMergedReleasePullRequest(repository) {
      const { owner, name } = splitRepository(repository);
      const data = await graphql<{
        repository: { pullRequests: { nodes: MergedGraphqlPullRequest[] } };
      }>(
        `
          query MergedReleasePullRequest($owner: String!, $name: String!) {
            repository(owner: $owner, name: $name) {
              pullRequests(
                first: 1
                states: MERGED
                baseRefName: "main"
                labels: ["autorelease: pending", "autorelease: tagged"]
                orderBy: { field: CREATED_AT, direction: DESC }
              ) {
                nodes {
                  number
                  mergeCommit {
                    oid
                  }
                  labels(first: 20) {
                    nodes {
                      name
                    }
                  }
                }
              }
            }
          }
        `,
        { owner, name },
      );
      const [merged] = data.repository.pullRequests.nodes;
      if (!merged) return undefined;
      if (!merged.mergeCommit) {
        throw new Error(`Release pull request #${merged.number} has no merge commit.`);
      }
      const result: MergedReleasePullRequest = {
        labels: merged.labels.nodes.map(({ name: label }) => label),
        mergeCommitSha: merged.mergeCommit.oid,
        number: merged.number,
      };
      return result;
    },

    getPullRequest: pullRequest,

    async pullRequestLabels(repository, number) {
      const pull = await pullRequest(repository, number);
      return pull.labels.map(({ name }) => name);
    },

    async listPullRequestFiles(repository, number) {
      async function listPage(page: number): Promise<string[]> {
        const files = await request<{ filename: string }[]>(
          `/repos/${repository}/pulls/${number}/files?per_page=100&page=${page}`,
        );
        const paths = files.map(({ filename }) => filename);
        return files.length < 100 ? paths : paths.concat(await listPage(page + 1));
      }
      return listPage(1);
    },

    listPullRequestsForCommit(repository, sha) {
      return request<AssociatedPullRequest[]>(
        `/repos/${repository}/commits/${sha}/pulls?per_page=100`,
      );
    },

    // GitHub can lag behind a push for a moment: the pull request and the
    // repository ref may report the previous head. Retry while both still
    // agree with the head we started from; any other head is another writer.
    async observePullRequest(repository, number, headRef, expectedHead, expectedDraft) {
      const previousHead = initialHeads.get(`${repository}#${number}`);
      async function observe(read: number): Promise<ReleasePullRequest> {
        const [pull, currentHead] = await Promise.all([
          pullRequest(repository, number),
          repositoryHead(repository, headRef),
        ]);
        const observed = fromRest(pull);
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
      const id = await pullRequestId(repository, number);
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
        { id },
      );
    },

    async markDraft(repository, number) {
      const id = await pullRequestId(repository, number);
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
        { id },
      );
    },
  };
}

type ExecFile = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string | Buffer }>;

type WorkingCopyFs = {
  mkdtemp(prefix: string): Promise<string>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  rm(path: string, options: { force: boolean; recursive: boolean }): Promise<void>;
  writeFile(path: string, contents: string, encoding: "utf8"): Promise<void>;
};

const execFileFromSystem: ExecFile = promisify(execFileWithCallback);

function exitCode(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

function changedPathsFromPorcelain(output: string | Buffer) {
  const records = output.toString().split("\0");
  const paths: string[] = [];
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

/**
 * Isolated temporary git checkouts of an exact Release pull request head,
 * authenticated with a short-lived token that never appears on a command line.
 */
export function createWorkingCopiesAdapter({
  repository,
  token,
  execFile = execFileFromSystem,
  fs = { mkdtemp, readFile, rm, writeFile },
  temporaryDirectory = tmpdir(),
}: {
  repository: string;
  token: string;
  execFile?: ExecFile;
  fs?: WorkingCopyFs;
  temporaryDirectory?: string;
}): WorkingCopies {
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
    async withExactHead(pullRequest, prepare) {
      const directory = await fs.mkdtemp(join(temporaryDirectory, "release-pull-request-"));
      const remote = `https://github.com/${repository}.git`;
      const git = (args: string[]) => execFile("git", args, { cwd: directory, env: gitEnv });

      const workingCopy: WorkingCopy = {
        readFile: (path, encoding) => fs.readFile(join(directory, path), encoding),
        writeFile: (path, contents, encoding) =>
          fs.writeFile(join(directory, path), contents, encoding),
        async changedPaths() {
          const { stdout } = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
          return changedPathsFromPorcelain(stdout);
        },
        stageChangelogs: () => git(["add", "--", ":(glob)packages/*/CHANGELOG.md"]),
        async hasStagedChanges() {
          try {
            await git(["diff", "--cached", "--quiet"]);
            return false;
          } catch (error) {
            if (exitCode(error) === 1) return true;
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
          return stdout.toString().trim();
        },
      };

      try {
        await git(["init", "--quiet"]);
        await git(["fetch", "--no-tags", "--depth=1", remote, pullRequest.headSha]);
        await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"]);
        return await prepare(workingCopy);
      } finally {
        await fs.rm(directory, { force: true, recursive: true });
      }
    },
  };
}

type RunCommand = (command: string, args: string[]) => Promise<number>;

type WorkspaceFs = {
  readdir(
    path: string,
    options: { withFileTypes: true },
  ): Promise<{ isDirectory(): boolean; name: string }[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
};

// Streams the command's output into the job log and resolves with its exit code.
const runFromSystem: RunCommand = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });

function packageName(manifest: string, path: string) {
  const parsed: unknown = JSON.parse(manifest);
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "name" in parsed &&
    typeof parsed.name === "string"
  ) {
    return parsed.name;
  }
  throw new Error(`${path} has no package name.`);
}

/**
 * The packages of the checked-out release commit. Publishing goes through
 * pnpm's recursive publish: only it skips versions already on npm and private
 * packages, which is what makes a re-run safe.
 */
export function createWorkspaceAdapter({
  cwd = process.cwd(),
  fs = { readdir, readFile },
  run = runFromSystem,
}: {
  cwd?: string;
  fs?: WorkspaceFs;
  run?: RunCommand;
}): Workspace {
  return {
    async listPackageNames() {
      const entries = await fs.readdir(join(cwd, "packages"), { withFileTypes: true });
      const names = await Promise.all(
        entries
          .filter((entry) => entry.isDirectory())
          .map(async (entry) => {
            const path = join("packages", entry.name, "package.json");
            return packageName(await fs.readFile(join(cwd, path), "utf8"), path);
          }),
      );
      return names.toSorted();
    },

    async publish(name) {
      const code = await run("pnpm", ["-r", "--filter", name, "publish", "--no-git-checks"]);
      return code === 0;
    },
  };
}

export function createProductionAdapters(options: {
  repository: string;
  token: string;
}): ReleaseAdapters {
  return {
    github: createGitHubAdapter(options),
    reportWarning: console.warn,
    workingCopies: createWorkingCopiesAdapter(options),
  };
}
