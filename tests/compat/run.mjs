import { runCommand } from "./run-command.mjs";
import { compatibilityLanes } from "./versions.mjs";

const repositoryDirectory = new URL("../../", import.meta.url);
const requestedLaneName = process.argv[2];
const selectedLanes = requestedLaneName
  ? compatibilityLanes.filter(({ name }) => name === requestedLaneName)
  : compatibilityLanes;

if (selectedLanes.length === 0) {
  throw new Error(
    `Unknown compatibility lane "${requestedLaneName}". Expected one of: ${compatibilityLanes
      .map(({ name }) => name)
      .join(", ")}.`,
  );
}

const runID = `${Date.now()}-${process.pid}`;
const composeProject = `payload-blurhash-compat-${runID}`;
const builtImages = [];

const runDocker = (arguments_) =>
  runCommand({
    arguments_,
    command: "docker",
    cwd: repositoryDirectory,
    env: { ...process.env, LOCALSTACK_PORT: "0" },
  });

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
  await runCommand({
    arguments_: ["--filter", "@codlume/payload-blurhash", "build"],
    command: "pnpm",
    cwd: repositoryDirectory,
    env: process.env,
  });
  await runDocker(["compose", "-p", composeProject, "up", "-d", "--wait", "localstack"]);
  const laneResults = await Promise.allSettled(selectedLanes.map(runLane));
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
