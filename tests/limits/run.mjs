import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "../run-command.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifactDirectory = path.join(repositoryRoot, "artifacts", "limits");
const image = `payload-blurhash-limits:${randomUUID()}`;

await mkdir(artifactDirectory, { recursive: true });

try {
  await runCommand({
    arguments_: [
      "build",
      "--file",
      path.join(repositoryRoot, "tests", "limits", "Dockerfile"),
      "--tag",
      image,
      repositoryRoot,
    ],
    command: "docker",
  });
  await runCommand({
    arguments_: [
      "run",
      "--rm",
      "--cpus=2",
      "--memory=2g",
      "--memory-swap=2g",
      "--volume",
      `${artifactDirectory}:/artifacts`,
      image,
    ],
    command: "docker",
  });
} finally {
  await runCommand({
    arguments_: ["image", "rm", "--force", image],
    command: "docker",
  }).catch(() => undefined);
}

console.log(`Resource-limit evidence: ${path.join(artifactDirectory, "blurhash-limits.json")}`);
