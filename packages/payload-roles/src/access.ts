import type { Access, AccessArgs, AccessResult } from "payload";

import type {
  ActionId,
  Enforcer,
  LifecycleModule,
  Resource,
  Subject,
  WriteKey,
} from "./contract.ts";
import { can } from "./grants.ts";
import { sameId } from "./resolve.ts";

export const COLLECTION_ACCESS_KEYS = [
  "create",
  "read",
  "update",
  "delete",
  "readVersions",
  "unlock",
] as const;

export const GLOBAL_ACCESS_KEYS = ["read", "update", "readVersions"] as const;

export type CollectionAccessKey = (typeof COLLECTION_ACCESS_KEYS)[number];
export type GlobalAccessKey = (typeof GLOBAL_ACCESS_KEYS)[number];
export type AccessKey = CollectionAccessKey | GlobalAccessKey;

/**
 * Roles side AND app side. A falsy result on either side is a denial, so an app function that
 * returns nothing cannot widen a `Where`. `true` on one side yields the other side's result.
 * Otherwise both are joined with `and`, so a roles `Where` always narrows the app's result.
 */
export const composeAccess = (
  roles: AccessResult,
  app: AccessResult | null | undefined,
): AccessResult => {
  if (!roles || !app) {
    return false;
  }
  if (roles === true) {
    return app;
  }
  if (app === true) {
    return roles;
  }
  return { and: [roles, app] };
};

/** Payload applies these after plugins run, so a missing app function composes with them. */
export const defaultAppAccess = (key: AccessKey): Access =>
  key === "unlock"
    ? ({ req }) => Boolean(req.user) && req.user?.collection === req.payload.config.admin.user
    : ({ req }) => Boolean(req.user);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const holdsAll = (
  subject: Extract<Subject, { kind: "member" }>,
  resource: Resource,
  actions: ReadonlySet<ActionId>,
) => {
  for (const action of actions) {
    if (resource.actions.has(action) && !can(subject.capabilities, resource.id, action)) {
      return false;
    }
  }
  return true;
};

export type RolesSideArgs = {
  resource: Resource;
  key: AccessKey;
  subject: Extract<Subject, { kind: "member" }>;
  args: AccessArgs;
  lifecycle: Pick<LifecycleModule, "requiredWriteActions">;
  isUsers: boolean;
};

/** The roles half of one access decision. A `Where` is returned only for self-read on users. */
export const rolesSide = ({
  resource,
  key,
  subject,
  args,
  lifecycle,
  isUsers,
}: RolesSideArgs): AccessResult => {
  const has = (action: ActionId) => can(subject.capabilities, resource.id, action);
  const data = isRecord(args.data) ? args.data : undefined;
  switch (key) {
    case "read":
      return has("read") || (isUsers ? { id: { equals: subject.id } } : false);
    case "create":
    case "update": {
      if (key === "update" && isUsers && args.id !== undefined && sameId(args.id, subject.id)) {
        return true;
      }
      const writeKey: WriteKey = key;
      const required = lifecycle.requiredWriteActions({
        resource,
        key: writeKey,
        data,
        id: args.id,
        req: args.req,
      });
      return holdsAll(subject, resource, required);
    }
    case "delete":
      return data?.deletedAt === undefined || data.deletedAt === null
        ? has("delete")
        : has("trash");
    case "readVersions":
    case "unlock":
      return has(key);
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
};

export type WrapAccessArgs = {
  resource: Resource;
  key: AccessKey;
  app: Access | undefined;
  enforcer: Enforcer;
  lifecycle: Pick<LifecycleModule, "requiredWriteActions">;
};

export const wrapAccess = ({ resource, key, app, enforcer, lifecycle }: WrapAccessArgs): Access => {
  const appAccess = app ?? defaultAppAccess(key);
  const isUsers =
    resource.kind === "collection" && resource.slug === enforcer.options.userCollection;
  return async (args) => {
    const subject = await enforcer.subject(args.req);
    if (subject.kind === "outsider" || subject.capabilities.kind === "all") {
      return appAccess(args);
    }
    const roles = rolesSide({ resource, key, subject, args, lifecycle, isUsers });
    if (roles === false) {
      enforcer.log.debug(args.req.payload, "access_denied", { resource: resource.id, key });
      return false;
    }
    return composeAccess(roles, await appAccess(args));
  };
};
