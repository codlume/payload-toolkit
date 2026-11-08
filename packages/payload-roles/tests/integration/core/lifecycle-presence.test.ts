// Core's startup reporting must follow the lifecycle module's own `enforcing` flag, whichever
// module is installed: the seeded interim rule or the lifecycle thread's enforcing module.
import { randomUUID } from "node:crypto";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, getPayload, type Payload } from "payload";
import { afterEach, expect, test, vi } from "vitest";

import type { LifecycleModule } from "../../../src/contract.ts";
import { rolesPlugin } from "../../../src/plugin.ts";
import { defaultRolesOptions, fixtureCollections, fixtureGlobals } from "../../helpers/payload.ts";

const installed = vi.hoisted(() => ({ enforcing: false }));

vi.mock("../../../src/lifecycle/index.ts", async (importOriginal) => {
  const original: { lifecycle: LifecycleModule } = await importOriginal();
  const lifecycle: LifecycleModule = {
    ...original.lifecycle,
    get enforcing() {
      return installed.enforcing;
    },
  };
  return { lifecycle };
});

let payload: Payload | undefined;

afterEach(async () => {
  await payload?.destroy();
  payload = undefined;
});

const startWithLifecycle = async (enforcing: boolean) => {
  installed.enforcing = enforcing;
  const events: unknown[] = [];
  const config = await buildConfig({
    collections: fixtureCollections(),
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    globals: fixtureGlobals(),
    logger: {
      destination: {
        write: (line: string) => {
          const entry: unknown = JSON.parse(line);
          if (typeof entry === "object" && entry !== null && "event" in entry) {
            events.push(entry.event);
          }
        },
      },
      options: { level: "debug" },
    },
    plugins: [rolesPlugin(defaultRolesOptions())],
    secret: "payload-roles-lifecycle-presence-secret",
    telemetry: false,
  });
  payload = await getPayload({ config, key: `lifecycle-presence-${randomUUID()}` });
  return events;
};

test("startup warns that lifecycle enforcement is not installed when the lifecycle module is not enforcing", async () => {
  expect(await startWithLifecycle(false)).toContain("lifecycle_not_installed");
});

test("startup does not warn when the lifecycle module is enforcing", async () => {
  expect(await startWithLifecycle(true)).not.toContain("lifecycle_not_installed");
});
