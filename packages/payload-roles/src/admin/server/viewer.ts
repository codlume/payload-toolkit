import { createLocalReq, type Payload, type TypeWithID } from "payload";

import type { Enforcer, Subject } from "../../contract.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const resolved = new WeakMap<object, Promise<Subject>>();

const resolve = async (
  enforcer: Enforcer,
  payload: Payload,
  user: Record<string, unknown>,
): Promise<Subject> => {
  const { rolesField, superAdminField, userCollection: collection } = enforcer.options;
  const { id } = user;
  if (user.collection !== collection || (typeof id !== "string" && typeof id !== "number")) {
    return { kind: "outsider" };
  }
  const row = await payload.db.findOne<Record<string, unknown> & TypeWithID>({
    collection,
    select: { [rolesField]: true, [superAdminField]: true },
    where: { id: { equals: id } },
  });
  if (!row) {
    return { kind: "outsider" };
  }
  const req = await createLocalReq({ user: { ...row, collection } }, payload);
  return enforcer.subject(req);
};

/**
 * The subject behind a document-slot `user` prop. Slots get no `req`, and their `user` has field
 * read access applied, so the stored row is reloaded and resolved as core resolves `req.user`.
 * Payload hands every slot of one document render the same `user` object, created per request,
 * so the slots share one resolution keyed by it.
 */
export const subjectOfViewer = (
  enforcer: Enforcer,
  payload: Payload,
  user: unknown,
): Promise<Subject> => {
  if (!isRecord(user)) {
    return Promise.resolve({ kind: "outsider" });
  }
  const hit = resolved.get(user);
  if (hit) {
    return hit;
  }
  const subject = resolve(enforcer, payload, user);
  resolved.set(user, subject);
  return subject;
};
