import { execFile as execFileWithCallback } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileFromSystem = promisify(execFileWithCallback);
const MAX_HEAD_READS = 10;
const HEAD_RETRY_DELAY_MS = 1_000;

function cliOption(argv, name) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  if (!argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return argv[index + 1];
}

function validHead(value) {
  return /^[0-9a-f]{40}$/i.test(value ?? "");
}

async function readPullRequest({ repository, pullRequestNumber, env, execFile }) {
  const { stdout } = await execFile(
    "gh",
    ["pr", "view", String(pullRequestNumber), "--repo", repository, "--json", "isDraft,state"],
    { env },
  );

  return JSON.parse(stdout.toString());
}

async function readRepositoryHead({ repository, headRef, env, execFile }) {
  const { stdout } = await execFile(
    "gh",
    ["api", `repos/${repository}/git/ref/heads/${headRef}`, "--jq", ".object.sha"],
    { env },
  );

  return stdout.toString().trim();
}

async function waitForExpectedHead({
  repository,
  pullRequestNumber,
  headRef,
  previousHead,
  expectedHead,
  env,
  execFile,
  wait,
}) {
  async function observe(read) {
    const [pullRequest, repositoryHead] = await Promise.all([
      readPullRequest({ repository, pullRequestNumber, env, execFile }),
      readRepositoryHead({ repository, headRef, env, execFile }),
    ]);

    if (pullRequest.state !== "OPEN" || pullRequest.isDraft !== true) {
      throw new Error(`Release PR #${pullRequestNumber} is no longer an open draft.`);
    }
    if (repositoryHead === expectedHead) {
      return { ...pullRequest, headRefOid: repositoryHead };
    }
    if (repositoryHead !== previousHead) {
      throw new Error(
        `Release PR #${pullRequestNumber} moved to ${repositoryHead} while waiting for ${expectedHead}.`,
      );
    }
    if (read === MAX_HEAD_READS) {
      throw new Error(
        `Release PR #${pullRequestNumber} still reports ${previousHead} after ${MAX_HEAD_READS} checks; expected ${expectedHead}.`,
      );
    }

    await wait(HEAD_RETRY_DELAY_MS);
    return observe(read + 1);
  }

  return observe(1);
}

export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  execFile = execFileFromSystem,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const repository = cliOption(argv, "--repo") ?? env.GITHUB_REPOSITORY;
  const pullRequest = cliOption(argv, "--pr") ?? env.RELEASE_PULL_REQUEST_NUMBER;
  const headRef = cliOption(argv, "--head-ref") ?? env.RELEASE_PULL_REQUEST_HEAD_REF;
  const previousHead = cliOption(argv, "--previous-head") ?? env.PREVIOUS_RELEASE_PULL_REQUEST_HEAD;
  const expectedHead = cliOption(argv, "--expected-head") ?? env.EXPECTED_RELEASE_PULL_REQUEST_HEAD;
  const pullRequestNumber = Number(pullRequest);

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Pass --repo owner/name or set GITHUB_REPOSITORY.");
  }
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error(
      "Pass --pr with a positive pull request number or set RELEASE_PULL_REQUEST_NUMBER.",
    );
  }
  if (!headRef || /\s/.test(headRef)) {
    throw new Error("Pass --head-ref or set RELEASE_PULL_REQUEST_HEAD_REF.");
  }
  if (!validHead(previousHead)) {
    throw new Error(
      "Pass --previous-head with a full commit SHA or set PREVIOUS_RELEASE_PULL_REQUEST_HEAD.",
    );
  }
  if (!validHead(expectedHead)) {
    throw new Error(
      "Pass --expected-head with a full commit SHA or set EXPECTED_RELEASE_PULL_REQUEST_HEAD.",
    );
  }

  return waitForExpectedHead({
    repository,
    pullRequestNumber,
    headRef,
    previousHead,
    expectedHead,
    env,
    execFile,
    wait,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
