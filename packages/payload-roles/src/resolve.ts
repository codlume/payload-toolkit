import type { Payload, PayloadRequest } from "payload";

import type {
  Capabilities,
  Diagnostics,
  Enforcer,
  Grants,
  Registry,
  ResolvedOptions,
  Subject,
  SubjectId,
} from "./contract.ts";
import { NO_CAPABILITIES, parsePermissions, unionGrants } from "./grants.ts";

/** Bounds how long a long-lived Local API user object can keep revoked grants. */
export const CAPABILITIES_TTL_MS = 5000;

type Entry = { expiresAt: number; promise: Promise<Capabilities> };

const memo = new WeakMap<object, Entry>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isId = (value: unknown): value is SubjectId =>
  typeof value === "string" || typeof value === "number";

/** Role ids from `user.roles`, which arrives as ids or populated docs depending on depth. */
export const normalizeRoleIds = (value: unknown): SubjectId[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const ids: SubjectId[] = [];
  for (const entry of value) {
    const id = isRecord(entry) ? entry.id : entry;
    if (isId(id) && !ids.some((seen) => sameId(seen, id))) {
      ids.push(id);
    }
  }
  return ids;
};

/** REST passes ids as strings while the database returns numbers on SQL adapters. */
export const sameId = (a: SubjectId, b: SubjectId) => String(a) === String(b);

export type RoleLoader = {
  options: ResolvedOptions;
  registry: Registry;
  log: Diagnostics;
};

/**
 * Reloads roles by id as stored rows inside the request's transaction, so no `afterRead` hook
 * shapes what a role grants. Dangling ids are simply absent.
 */
export const loadRoleGrants = async (
  deps: RoleLoader,
  payload: Payload,
  req: PayloadRequest | undefined,
  ids: readonly SubjectId[],
): Promise<Map<string, Grants>> => {
  if (ids.length === 0) {
    return new Map();
  }
  const result = await payload.db.find({
    collection: deps.options.rolesSlug,
    limit: ids.length,
    pagination: false,
    where: { id: { in: [...ids] } },
    ...(req && { req }),
  });
  const grants = new Map<string, Grants>();
  for (const row of result.docs) {
    const doc: unknown = row;
    if (!isRecord(doc)) {
      continue;
    }
    const parsed = parsePermissions(doc[deps.options.permissionsField], deps.registry);
    if (parsed.issues.length > 0) {
      deps.log.debug(payload, "permissions_dropped", { role: doc.id, issues: parsed.issues });
    }
    grants.set(String(doc.id), parsed.grants);
  }
  return grants;
};

/** Capabilities of a user document fetched at any depth. Never reads grants from populated roles. */
export const capabilitiesOfUser = async (
  deps: RoleLoader,
  payload: Payload,
  req: PayloadRequest | undefined,
  user: Record<string, unknown>,
): Promise<Capabilities> => {
  if (user[deps.options.superAdminField] === true) {
    return { kind: "all" };
  }
  const ids = normalizeRoleIds(user[deps.options.rolesField]);
  const grants = await loadRoleGrants(deps, payload, req, ids);
  return { kind: "grants", grants: unionGrants(grants.values()) };
};

export const createResolver = (deps: RoleLoader): Enforcer["subject"] => {
  const resolve = (req: PayloadRequest, user: Record<string, unknown>): Promise<Capabilities> => {
    const now = Date.now();
    const hit = memo.get(user);
    if (hit && hit.expiresAt > now) {
      return hit.promise;
    }
    // The memoized promise never rejects, so every caller that shares a failed lookup gets no
    // grants instead of the lookup's error.
    const entry: Entry = {
      expiresAt: now + CAPABILITIES_TTL_MS,
      promise: capabilitiesOfUser(deps, req.payload, req, user).catch((error: unknown) => {
        if (memo.get(user) === entry) {
          memo.delete(user);
        }
        deps.log.error(req.payload, "capabilities_unavailable", {
          user: user.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return NO_CAPABILITIES;
      }),
    };
    memo.set(user, entry);
    return entry.promise;
  };

  return async (req): Promise<Subject> => {
    const user: unknown = req.user;
    if (!isRecord(user) || user.collection !== deps.options.userCollection || !isId(user.id)) {
      return { kind: "outsider" };
    }
    return { kind: "member", id: user.id, capabilities: await resolve(req, user) };
  };
};
