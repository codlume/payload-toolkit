import { spawn } from "node:child_process";

import { compatibilityLanes } from "./versions.mjs";

const repositoryDirectory = new URL("../../", import.meta.url);
const runID = `${Date.now()}-${process.pid}`;
const composeProject = `payload-blurhash-compat-${runID}`;
const builtImages = [];

const run = ({ arguments_, command }) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: repositoryDirectory,
      env: process.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`${command} exited with ${code ?? signal}`));
    });
  });

const runDocker = (arguments_) => run({ arguments_, command: "docker" });

const runLane = async (lane) => {
  const image = `${composeProject}-${lane.name}`;
  console.log(`Building ${lane.name} compatibility lane (Node ${lane.node})...`);
  await runDocker([
    "build",
    "--file",
    "tests/compat/Dockerfile",
    "--build-arg",
    `NODE_VERSION=${lane.node}`,
    "--tag",
    image,
    ".",
  ]);
  builtImages.push(image);

  console.log(
    `Running ${lane.name} compatibility lane (Node ${lane.node}, Payload ${lane.payload})...`,
  );
  await runDocker([
    "run",
    "--rm",
    "--network",
    `${composeProject}_default`,
    "--env",
    `COMPAT_LANE=${lane.name}`,
    "--env",
    `COMPAT_NODE_VERSION=${lane.node}`,
    "--env",
    `COMPAT_PAYLOAD_VERSION=${lane.payload}`,
    "--env",
    "PAYLOAD_S3_ENDPOINT=http://localstack:4566",
    image,
  ]);
};

try {
  await run({
    arguments_: ["--filter", "@codlume/payload-blurhash", "build"],
    command: "pnpm",
  });
  await runDocker(["compose", "-p", composeProject, "up", "-d", "--wait", "localstack"]);
  const laneResults = await Promise.allSettled(compatibilityLanes.map(runLane));
  const failedLane = laneResults.find(({ status }) => status === "rejected");

  if (failedLane) {
    throw failedLane.reason;
  }
} finally {
  await runDocker(["compose", "-p", composeProject, "down", "--remove-orphans", "--volumes"]).catch(
    () => undefined,
  );
  await Promise.all(
    builtImages.map((image) => runDocker(["image", "rm", image]).catch(() => undefined)),
  );
}
