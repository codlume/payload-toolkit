import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { createE2EPayload, seedAdminUser } from "../e2e/e2e-context.ts";

let directory: string;
let payload: Awaited<ReturnType<typeof createE2EPayload>>;

beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "payload-sqlite-contention-"));
  vi.stubEnv("PAYLOAD_E2E_STATE_DIRECTORY", directory);
  vi.stubEnv("PAYLOAD_E2E_S3_PREFIX", "tests/sqlite-contention");
  payload = await createE2EPayload("enabled");
});

afterAll(async () => {
  await payload?.destroy();
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

test.each(["read", "write", "connect"] as const)(
  "E2E %s waits for another connection's brief write lock",
  async (operation) => {
    const writer = fork(new URL("../fixtures/sqlite-write-lock.mjs", import.meta.url), [
      path.join(directory, "enabled", "payload.db"),
    ]);
    const exited = once(writer, "exit");
    try {
      await once(writer, "message");
      if (operation === "read") {
        await expect(seedAdminUser(payload)).resolves.toMatchObject({
          email: "preview@example.com",
        });
      } else if (operation === "write") {
        await expect(
          payload.create({
            collection: "pages",
            draft: true,
            data: { title: "Concurrent draft", slug: "concurrent-draft", layout: [] },
          }),
        ).resolves.toMatchObject({ title: "Concurrent draft" });
      } else {
        const retry = await createE2EPayload("enabled");
        try {
          await expect(seedAdminUser(retry)).resolves.toMatchObject({
            email: "preview@example.com",
          });
        } finally {
          await retry.destroy();
        }
      }
    } finally {
      await exited;
    }
  },
);
