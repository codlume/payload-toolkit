import { createLocalReq, type Payload, type TypeWithID } from "payload";

import type { Enforcer, Subject } from "../../contract.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * The subject behind a document-slot `user` prop. Slots get no `req`, and their `user` has field
 * read access applied, so the stored row is reloaded and resolved as core resolves `req.user`.
 */
export const subjectOfViewer = async (
  enforcer: Enforcer,
  payload: Payload,
  user: unknown,
): Promise<Subject> => {
  const collection = enforcer.options.userCollection;
  if (!isRecord(user) || user.collection !== collection) {
    return { kind: "outsider" };
  }
  const { id } = user;
  if (typeof id !== "string" && typeof id !== "number") {
    return { kind: "outsider" };
  }
  const row = await payload.db.findOne<Record<string, unknown> & TypeWithID>({
    collection,
    where: { id: { equals: id } },
  });
  if (!row) {
    return { kind: "outsider" };
  }
  const req = await createLocalReq({ user: { ...row, collection } }, payload);
  return enforcer.subject(req);
};
