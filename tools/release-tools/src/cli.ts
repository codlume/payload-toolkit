import { pathToFileURL } from "node:url";

import { createProductionAdapters } from "./adapters.ts";
import { prepareReleasePullRequest } from "./prepare-release-pull-request.ts";

type CommandContext = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
};

async function preparePullRequest({ env, log }: CommandContext) {
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

const commands = new Map<string, (context: CommandContext) => Promise<unknown>>([
  ["prepare-pull-request", preparePullRequest],
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
