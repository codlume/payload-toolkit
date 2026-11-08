// Core-owned test actors: seed roles and users, then drive Payload as one of them over the
// Local API (`as`), REST (`rest`) or GraphQL (`graphql`).
import { createRequire } from "node:module";

import { configToSchema } from "@payloadcms/graphql";
import type { execute as executeType, parse as parseType } from "graphql";
import { createPayloadRequest, handleEndpoints, type Payload, type Where } from "payload";

import type { TestPayload } from "./payload.ts";

export type Permissions = {
  collections?: Record<string, { actions: string[] }>;
  globals?: Record<string, { actions: string[] }>;
};

export type Actor = Record<string, unknown> & {
  collection: string;
  email: string;
  id: number | string;
};

export const PASSWORD = "correct horse battery staple";

export const seedRole = async (
  payload: Payload,
  key: string,
  permissions: Permissions,
): Promise<number | string> => {
  const role = await payload.create({
    collection: "roles",
    data: { key, name: key, permissions },
    depth: 0,
  });
  return role.id;
};

export type SeedUser = {
  email: string;
  roles?: (number | string)[];
  superAdmin?: boolean;
  password?: string;
};

/** Trusted Local API create, then a fresh depth-0 read so `collection` is set for `as`. */
export const seedUser = async (payload: Payload, user: SeedUser): Promise<Actor> => {
  const created = await payload.create({
    collection: "users",
    data: {
      email: user.email,
      password: user.password ?? PASSWORD,
      roles: user.roles ?? [],
      superAdmin: user.superAdmin ?? false,
    },
    depth: 0,
  });
  return fresh(payload, created.id);
};

/** A new user object, so the per-object capability memo does not serve a stale answer. */
export const fresh = async (payload: Payload, id: number | string): Promise<Actor> => {
  const doc: Record<string, unknown> = await payload.findByID({
    collection: "users",
    depth: 0,
    id,
  });
  const { email } = doc;
  if (typeof email !== "string") {
    throw new TypeError(`user ${String(id)} has no email`);
  }
  return { ...doc, collection: "users", email, id };
};

type Local = Pick<
  Payload,
  | "count"
  | "create"
  | "duplicate"
  | "find"
  | "findByID"
  | "findGlobal"
  | "findVersions"
  | "restoreVersion"
  | "updateGlobal"
>;

type WithoutTrust<Options> = Options extends unknown
  ? Omit<Options, "overrideAccess" | "user">
  : never;

type Untrusted<Fn> = Fn extends (options: infer Options) => infer Result
  ? (options: WithoutTrust<Options>) => Result
  : never;

type Doc = Record<string, unknown>;

type ById = { collection: string; id: number | string };
type ByWhere = { collection: string; where: Where };

type Derived = { [K in keyof Local]: Untrusted<Local[K]> };

/**
 * Local API as `user`, with access control on. `update` and `delete` are Payload overloads,
 * so the by-id and by-where forms are separate methods here.
 */
export const as = (
  payload: Payload,
  user: Actor,
): Derived & {
  delete: (options: ById & { trash?: boolean }) => Promise<Doc>;
  deleteMany: (options: ByWhere) => ReturnType<Payload["delete"]>;
  update: (options: ById & { data: Doc }) => Promise<Doc>;
  updateMany: (options: ByWhere & { data: Doc }) => ReturnType<Payload["delete"]>;
} => ({
  count: (options) => payload.count({ ...options, overrideAccess: false, user }),
  create: (options) => payload.create({ ...options, overrideAccess: false, user }),
  delete: (options: ById & { trash?: boolean }) =>
    payload.delete({ ...options, overrideAccess: false, user }),
  deleteMany: (options) => payload.delete({ ...options, overrideAccess: false, user }),
  duplicate: (options) => payload.duplicate({ ...options, overrideAccess: false, user }),
  find: (options) => payload.find({ ...options, overrideAccess: false, user }),
  findByID: (options) => payload.findByID({ ...options, overrideAccess: false, user }),
  findGlobal: (options) => payload.findGlobal({ ...options, overrideAccess: false, user }),
  findVersions: (options) => payload.findVersions({ ...options, overrideAccess: false, user }),
  restoreVersion: (options) => payload.restoreVersion({ ...options, overrideAccess: false, user }),
  update: (options: ById & { data: Doc }) =>
    payload.update({ ...options, overrideAccess: false, user }),
  updateMany: (options) => payload.update({ ...options, overrideAccess: false, user }),
  updateGlobal: (options) => payload.updateGlobal({ ...options, overrideAccess: false, user }),
});

export const login = async (payload: Payload, email: string, password = PASSWORD) => {
  const result = await payload.login({ collection: "users", data: { email, password } });
  if (!result.token) {
    throw new Error(`login returned no token for ${email}`);
  }
  return result.token;
};

export type RestResponse = { status: number; json: Record<string, unknown> | null };

const parseJSON = (text: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? { ...parsed } : null;
  } catch {
    return null;
  }
};

/** REST through `handleEndpoints`, the function Payload's Next route handlers call. */
export const rest =
  ({ config, key }: TestPayload, token: null | string) =>
  async (method: string, path: string, body?: unknown): Promise<RestResponse> => {
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `JWT ${token}`;
    }
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    const response = await handleEndpoints({
      config,
      payloadInstanceCacheKey: key,
      request: new Request(`http://localhost/api${path}`, {
        ...(body !== undefined && { body: JSON.stringify(body) }),
        headers,
        method,
      }),
    });
    return { json: parseJSON(await response.text()), status: response.status };
  };

const schemas = new WeakMap<TestPayload["config"], ReturnType<typeof configToSchema>>();

// `@payloadcms/graphql` is loaded by Node and gets graphql's CommonJS build; the test must use
// the same instance or `execute` rejects the schema as coming from another realm.
const { execute, parse }: { execute: typeof executeType; parse: typeof parseType } = createRequire(
  import.meta.url,
)("graphql");

/** GraphQL the way `@payloadcms/next` runs it: a Payload request plus `configToSchema`. */
export const graphql = async (
  context: TestPayload,
  token: null | string,
  query: string,
  variables?: Record<string, unknown>,
) => {
  const { config, key } = context;
  const request = new Request("http://localhost/api/graphql", {
    body: JSON.stringify({ query, variables }),
    headers: {
      "Content-Type": "application/json",
      ...(token && { Authorization: `JWT ${token}` }),
    },
    method: "POST",
  });
  const req = await createPayloadRequest({ config, payloadInstanceCacheKey: key, request });
  const built = schemas.get(config) ?? configToSchema(config);
  schemas.set(config, built);
  return execute({
    contextValue: { headers: {}, req },
    document: parse(query),
    schema: built.schema,
    ...(variables && { variableValues: variables }),
  });
};
