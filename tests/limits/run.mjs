import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runCommand } from "./run-command.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const artifactDirectory = path.join(repositoryRoot, "artifacts", "limits");
const image = `payload-blurhash-limits:${randomUUID()}`;

await mkdir(artifactDirectory, { recursive: true });

try {
  await runCommand("docker", [
    "build",
    "--file",
    path.join(repositoryRoot, "tests", "limits", "Dockerfile"),
    "--tag",
    image,
    repositoryRoot,
  ]);
  await runCommand("docker", [
    "run",
    "--rm",
    "--cpus=2",
    "--memory=2g",
    "--memory-swap=2g",
    "--volume",
    `${artifactDirectory}:/artifacts`,
    image,
  ]);
} finally {
  await runCommand("docker", ["image", "rm", "--force", image]).catch(() => undefined);
}

console.log(`Resource-limit evidence: ${path.join(artifactDirectory, "blurhash-limits.json")}`);
