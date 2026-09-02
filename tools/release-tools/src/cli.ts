import { appendFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createProductionAdapters, createWorkspaceAdapter } from "./adapters.ts";
import { prepareReleasePullRequest } from "./prepare-release-pull-request.ts";
import {
  findReleaseCommit,
  holdReleasePullRequestDraft,
  publishPackages,
  verifyReleasePullRequestTagged,
} from "./release-workflow.ts";

type CommandContext = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
};

function githubFromEnv(env: NodeJS.ProcessEnv) {
  const repository = env.GITHUB_REPOSITORY;
  const token = env.GH_TOKEN ?? env.GITHUB_TOKEN;

  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("Set GITHUB_REPOSITORY to owner/name.");
  }
  if (!token) throw new Error("Set GH_TOKEN or GITHUB_TOKEN.");

  return { adapters: createProductionAdapters({ repository, token }), repository };
}

async function holdDraft({ env, log }: CommandContext) {
  const { adapters, repository } = githubFromEnv(env);
  const result = await holdReleasePullRequestDraft({ repository }, adapters);

  if (result.outcome === "no-release-pull-request") {
    log("No existing Release pull request to hold as draft.");
  } else if (result.outcome === "already-draft") {
    log(`Release pull request #${result.pullRequestNumber} is already a draft.`);
  } else {
    log(`Release pull request #${result.pullRequestNumber} moved back to draft.`);
  }
  return result;
}

async function releaseCommit({ env, log }: CommandContext) {
  const outputFile = env.GITHUB_OUTPUT;
  if (!outputFile) throw new Error("Set GITHUB_OUTPUT to the workflow outputs file.");
  const { adapters, repository } = githubFromEnv(env);

  const result = await findReleaseCommit(
    { repository, runAttempt: Number(env.GITHUB_RUN_ATTEMPT ?? "1") },
    adapters,
  );
  log(result.message);
  const lines = Object.entries(result.outputs).map(([key, value]) => `${key}=${value}\n`);
  await appendFile(outputFile, lines.join(""), "utf8");
  return result;
}

async function preparePullRequest({ env, log }: CommandContext) {
  const { adapters, repository } = githubFromEnv(env);
  const result = await prepareReleasePullRequest({ repository }, adapters);

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

async function verifyTagged({ env, log }: CommandContext) {
  const pullRequestNumber = Number(env.RELEASE_PR);
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber < 1) {
    throw new Error("Set RELEASE_PR to the merged Release pull request number.");
  }
  const { adapters, repository } = githubFromEnv(env);

  await verifyReleasePullRequestTagged({ repository, pullRequestNumber }, adapters);
  log(`Release pull request #${pullRequestNumber} is tagged.`);
}

function publish({ log }: CommandContext) {
  return publishPackages({ log, workspace: createWorkspaceAdapter({}) });
}

const commands = new Map<string, (context: CommandContext) => Promise<unknown>>([
  ["hold-draft", holdDraft],
  ["find-release-commit", releaseCommit],
  ["prepare-pull-request", preparePullRequest],
  ["verify-tagged", verifyTagged],
  ["publish", publish],
]);

/** Dispatches `node src/cli.ts <command>`; the Release workflow is the only caller. */
export async function runCli({
  argv = process.argv.slice(2),
  env = process.env,
  log = console.log,
}: Partial<CommandContext> = {}) {
  const [command, ...rest] = argv;
  const run = command === undefined ? undefined : commands.get(command);
  if (!run) {
    throw new Error(`Usage: node src/cli.ts <${[...commands.keys()].join("|")}>`);
  }
  return run({ argv: rest, env, log });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // GitHub Actions turns ::error:: lines into annotations on the failed step.
    console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message);
    process.exitCode = 1;
  });
}
