// Core-owned test harness. The lifecycle and admin threads build on these helpers.
import { randomUUID } from "node:crypto";

import { sqliteAdapter } from "@payloadcms/db-sqlite";
import {
  buildConfig,
  type CollectionConfig,
  getPayload,
  type GlobalConfig,
  type Payload,
  type Plugin,
  type SanitizedConfig,
} from "payload";

import { rolesPlugin, type RolesPluginOptions } from "@codlume/payload-roles";

// Drizzle skips the schema push for a second instance in one process unless forced.
process.env.PAYLOAD_FORCE_DRIZZLE_PUSH = "true";

export type LogLine = Record<string, unknown>;

export type TestPayload = {
  payload: Payload;
  config: SanitizedConfig;
  key: string;
  /** Every log line Payload emitted, parsed. */
  logs: LogLine[];
  destroy: () => Promise<void>;
};

export const fixtureCollections = (): CollectionConfig[] => [
  { auth: true, fields: [], slug: "users" },
  {
    fields: [{ name: "title", type: "text" }],
    slug: "pages",
    trash: true,
    versions: { drafts: true },
  },
  {
    access: { read: () => true },
    fields: [{ name: "title", type: "text" }],
    slug: "posts",
  },
  {
    access: {
      read: ({ req }) => (req.user ? { title: { not_equals: "hidden" } } : false),
      update: () => false,
    },
    fields: [{ name: "title", type: "text" }],
    slug: "notes",
  },
];

export const fixtureGlobals = (): GlobalConfig[] => [
  { fields: [{ name: "siteName", type: "text" }], slug: "settings", versions: { drafts: true } },
];

export const defaultRolesOptions = (): RolesPluginOptions => ({
  collections: ["users", "pages", "posts", "notes"],
  debug: true,
  globals: ["settings"],
});

export type TestPayloadOptions = {
  name: string;
  collections?: CollectionConfig[];
  globals?: GlobalConfig[];
  roles?: RolesPluginOptions;
  /** Registered after the roles plugin, in array order. */
  plugins?: Plugin[];
};

const parseLine = (line: string): LogLine => {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? { ...parsed } : { msg: line };
  } catch {
    return { msg: line };
  }
};

export const createTestConfig = (options: TestPayloadOptions, logs: LogLine[]) =>
  buildConfig({
    collections: options.collections ?? fixtureCollections(),
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    globals: options.globals ?? fixtureGlobals(),
    logger: {
      destination: { write: (line: string) => void logs.push(parseLine(line)) },
      options: { level: "debug" },
    },
    plugins: [rolesPlugin(options.roles ?? defaultRolesOptions()), ...(options.plugins ?? [])],
    secret: "payload-roles-test-secret",
    telemetry: false,
  });

export const createTestPayload = async (options: TestPayloadOptions): Promise<TestPayload> => {
  const logs: LogLine[] = [];
  const key = `${options.name}-${randomUUID()}`;
  const config = await createTestConfig(options, logs);
  const payload = await getPayload({ config, key });
  return { config, destroy: () => payload.destroy(), key, logs, payload };
};
