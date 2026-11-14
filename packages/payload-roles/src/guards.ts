// Pure decisions for writes to the users and roles collections, one document at a time. The
// hooks in hooks.ts gather the inputs, call these, and throw.
import type {
  Capabilities,
  Grants,
  Registry,
  ResolvedOptions,
  StoredPermissions,
  SubjectId,
} from "./contract.ts";
import {
  checkPermissions,
  covers,
  describeCellIssue,
  missingFrom,
  serializePermissions,
} from "./grants.ts";
import { normalizeRoleIds, sameId } from "./resolve.ts";

export type FieldError = { path: string; message: string };

export type ForbiddenReason =
  | "last-super-admin"
  | "own-roles"
  | "role-not-covered"
  | "super-admin-field"
  | "target-missing"
  | "target-not-covered"
  | "target-super-admin"
  | "unknown-role";

export type Decision =
  | { kind: "allow" }
  | { kind: "forbidden"; reason: ForbiddenReason }
  | { kind: "invalid"; errors: readonly FieldError[] };

const ALLOW: Decision = { kind: "allow" };

const forbidden = (reason: ForbiddenReason): Decision => ({ kind: "forbidden", reason });

/**
 * Keys whose change on another user is an account takeover or a lockout when that user holds
 * more than the editor. `deletedAt` is included because trashing is a soft delete. `hash` and
 * `salt` are the stored password, which a restored version carries. `_verified` counts unless
 * it is set to `true`: login refuses an unverified user, and Payload's first-register verifies
 * the new user on the anonymous request.
 */
export const SENSITIVE_KEYS = [
  "password",
  "hash",
  "salt",
  "email",
  "username",
  "apiKey",
  "enableAPIKey",
  "lockUntil",
  "loginAttempts",
  "sessions",
  "deletedAt",
  "_verified",
] as const;

type Fields = Pick<ResolvedOptions, "rolesField" | "superAdminField">;

export type UserTarget = {
  id: SubjectId;
  superAdmin: boolean;
  /** A trashed super admin is not an active one for the last-super-admin rule. */
  trashed: boolean;
  roleIds: readonly SubjectId[];
  capabilities: Capabilities;
  /** The stored row, for value comparison of sensitive keys. */
  doc: Readonly<Record<string, unknown>>;
};

/** A stored user before the grants of its roles are read. */
export type StoredUser = Omit<UserTarget, "capabilities">;

const isId = (value: unknown): value is SubjectId =>
  typeof value === "string" || typeof value === "number";

const normalize = (value: unknown): unknown => {
  if (value === undefined || value === null) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(normalize);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, entry]) => [key, normalize(entry)] as const)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
};

export const sameValue = (a: unknown, b: unknown) =>
  JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

/**
 * A key counts as changed by value, except `password`, which is a change whenever it is sent
 * non-empty, and `_verified`, which never is when sent as `true`. A key sent as `undefined` is
 * absent, as it is for Payload.
 */
const sensitiveChange = (
  raw: Readonly<Record<string, unknown>>,
  doc: Readonly<Record<string, unknown>>,
) =>
  SENSITIVE_KEYS.some((key) => {
    const value = raw[key];
    if (key === "password") {
      return typeof value === "string" && value.length > 0;
    }
    if (key === "_verified" && value === true) {
      return false;
    }
    return value !== undefined && !sameValue(value, doc[key]);
  });

const isTrash = (raw: Readonly<Record<string, unknown>>) =>
  raw.deletedAt !== undefined && raw.deletedAt !== null;

/** True when the write turns an active super admin into a non-admin or trashes them. */
export const removesSuperAdmin = (
  raw: Readonly<Record<string, unknown>>,
  target: Pick<UserTarget, "superAdmin" | "trashed">,
  fields: Fields,
) =>
  target.superAdmin && !target.trashed && (raw[fields.superAdminField] === false || isTrash(raw));

type PrivilegedBody = {
  /** `undefined` when the body does not carry the field. */
  superAdmin: boolean | undefined;
  roleIds: readonly SubjectId[] | undefined;
};

/**
 * Reads the privileged fields in their stored shape and refuses every other one. Payload turns
 * `"true"` into `true` and wraps a scalar id into an array, and its field access drops a key
 * silently, so the body is judged as the client sent it and never second-guessed.
 */
const parsePrivileged = (
  raw: Readonly<Record<string, unknown>>,
  fields: Fields,
): { body: PrivilegedBody; errors: FieldError[] } => {
  const errors: FieldError[] = [];
  const superAdmin = raw[fields.superAdminField];
  if (superAdmin !== undefined && typeof superAdmin !== "boolean") {
    errors.push({
      path: fields.superAdminField,
      message: `${fields.superAdminField} must be true or false.`,
    });
  }
  const roles = raw[fields.rolesField];
  const roleIds =
    roles === undefined
      ? undefined
      : roles === null
        ? []
        : Array.isArray(roles) && roles.every(isId)
          ? normalizeRoleIds(roles)
          : undefined;
  if (roles !== undefined && roleIds === undefined) {
    errors.push({
      path: fields.rolesField,
      message: `${fields.rolesField} must be an array of role ids.`,
    });
  }
  return {
    body: { superAdmin: typeof superAdmin === "boolean" ? superAdmin : undefined, roleIds },
    errors,
  };
};

export type UserWriteInput = {
  editor: Capabilities;
  editorId: null | SubjectId;
  /** The privileged keys as the client sent them, over the data Payload is about to write. */
  raw: Readonly<Record<string, unknown>>;
  /** The stored target on update, null on create. */
  target: null | UserTarget;
  /** Grants of every role id the decision may need, keyed by `String(id)`. A missing id is dangling. */
  roleGrants: ReadonlyMap<string, Grants>;
  /** Active super admins before this write, less those the same operation already removed. */
  superAdminCount: number;
  fields: Fields;
};

const roleChanges = (incoming: readonly SubjectId[] | undefined, target: null | StoredUser) => {
  if (incoming === undefined) {
    return null;
  }
  const current = target?.roleIds ?? [];
  const added = incoming.filter((id) => !current.some((c) => sameId(c, id)));
  const removed = current.filter((id) => !incoming.some((i) => sameId(i, id)));
  return added.length + removed.length === 0 ? null : { added, removed };
};

type UserWriteRequest = Pick<UserWriteInput, "editor" | "editorId" | "fields" | "raw"> & {
  target: null | StoredUser;
};

/**
 * What one body asks for, from the body and the stored row alone. `changes` and `takeover` are
 * the only two gates behind which `decideUserWrite` reads role grants.
 */
const readUserWrite = ({ editor, editorId, raw, target, fields }: UserWriteRequest) => {
  const { body, errors } = parsePrivileged(raw, fields);
  const all = editor.kind === "all";
  const isSelf = target !== null && editorId !== null && sameId(target.id, editorId);
  return {
    body,
    errors,
    all,
    isSelf,
    changes: roleChanges(body.roleIds, target),
    /** Another member changes a sensitive key, so the target's capabilities are compared. */
    takeover: target !== null && !isSelf && !all && sensitiveChange(raw, target.doc),
  };
};

/**
 * The roles whose grants `decideUserWrite` reads for one body: those the body adds or removes,
 * and the target's own when its capabilities are compared. The hook loads only these, so this
 * may name more roles than the decision reads but never fewer.
 */
export const roleIdsRead = (request: UserWriteRequest): readonly SubjectId[] => {
  const { errors, changes, takeover } = readUserWrite(request);
  if (errors.length > 0) {
    return [];
  }
  return [
    ...(changes ? [...changes.added, ...changes.removed] : []),
    ...(takeover ? (request.target?.roleIds ?? []) : []),
  ];
};

export const decideUserWrite = ({
  editor,
  editorId,
  raw,
  target,
  roleGrants,
  superAdminCount,
  fields,
}: UserWriteInput): Decision => {
  const { body, errors, all, isSelf, changes, takeover } = readUserWrite({
    editor,
    editorId,
    raw,
    target,
    fields,
  });
  if (errors.length > 0) {
    return { kind: "invalid", errors };
  }
  const currentSuper = target?.superAdmin ?? false;

  if (body.superAdmin !== undefined && body.superAdmin !== currentSuper && !all) {
    return forbidden("super-admin-field");
  }
  if (target && removesSuperAdmin(raw, target, fields) && superAdminCount <= 1) {
    return forbidden("last-super-admin");
  }

  if (changes) {
    if (!all && isSelf) {
      return forbidden("own-roles");
    }
    for (const id of changes.added) {
      const grants = roleGrants.get(String(id));
      if (!grants) {
        return forbidden("unknown-role");
      }
      if (missingFrom(grants, editor).length > 0) {
        return forbidden("role-not-covered");
      }
    }
    for (const id of changes.removed) {
      const grants = roleGrants.get(String(id));
      if (grants && missingFrom(grants, editor).length > 0) {
        return forbidden("role-not-covered");
      }
    }
  }

  if (target && takeover) {
    if (target.superAdmin) {
      return forbidden("target-super-admin");
    }
    if (!covers(editor, target.capabilities)) {
      return forbidden("target-not-covered");
    }
  }

  return ALLOW;
};

export type UserDeleteInput = {
  editor: Capabilities;
  target: Pick<UserTarget, "capabilities" | "superAdmin" | "trashed">;
  /** Active super admins before this delete, less those the same operation already removed. */
  superAdminCount: number;
};

export const decideUserDelete = ({
  editor,
  target,
  superAdminCount,
}: UserDeleteInput): Decision => {
  if (target.superAdmin && !target.trashed && superAdminCount <= 1) {
    return forbidden("last-super-admin");
  }
  if (editor.kind === "all") {
    return ALLOW;
  }
  if (target.superAdmin) {
    return forbidden("target-super-admin");
  }
  if (!covers(editor, target.capabilities)) {
    return forbidden("target-not-covered");
  }
  return ALLOW;
};

/**
 * A non-super-admin may change or delete a role only when they hold every cell it grants now.
 * Otherwise they could strip a stronger user's role and then change that user's credentials.
 */
const coversRole = (editor: Capabilities, current: Grants | null) =>
  current === null || missingFrom(current, editor).length === 0;

export type RoleWriteInput = {
  editor: Capabilities;
  /** The `key` and permissions as the client sent them, over the data Payload is about to write. */
  raw: Readonly<Record<string, unknown>>;
  /** Stored key on update, null on create. */
  targetKey: null | string;
  /** Stored grants of the role on update, null on create. */
  current: Grants | null;
  registry: Registry;
  permissionsField: ResolvedOptions["permissionsField"];
};

export type RoleWriteResult = {
  decision: Decision;
  /** Canonical permissions to store, when the body carried any. */
  canonical: null | StoredPermissions;
};

export const decideRoleWrite = ({
  editor,
  raw,
  targetKey,
  current,
  registry,
  permissionsField,
}: RoleWriteInput): RoleWriteResult => {
  if (!coversRole(editor, current)) {
    return { decision: forbidden("role-not-covered"), canonical: null };
  }
  const errors: FieldError[] = [];
  if (targetKey !== null && raw.key !== undefined && raw.key !== targetKey) {
    errors.push({ path: "key", message: "A role's key cannot change after it is created." });
  }
  let canonical: null | StoredPermissions = null;
  if (permissionsField in raw) {
    const checked = checkPermissions(raw[permissionsField], registry, editor);
    // One error at the field's own path. Payload's admin form adds a form-state entry for
    // each error path and sends its null value with the next save, so a path inside the JSON
    // would overwrite the editor's retry; it also keeps only one message per path.
    if (checked.issues.length > 0) {
      errors.push({
        path: permissionsField,
        message: checked.issues
          .map((issue) => `${issue.path}: ${describeCellIssue(issue)}`)
          .join("\n"),
      });
    }
    canonical = serializePermissions(checked.grants, registry);
  }
  return {
    decision: errors.length > 0 ? { kind: "invalid", errors } : ALLOW,
    canonical,
  };
};

export const decideRoleDelete = (editor: Capabilities, current: Grants): Decision =>
  coversRole(editor, current) ? ALLOW : forbidden("role-not-covered");
