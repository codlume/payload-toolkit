import { AsyncLocalStorage } from "node:async_hooks";

import type { DefaultDocumentIDType } from "payload";

export type OperationKind = "create" | "delete" | "update";

/**
 * The documents one operation writes. `id` is undefined when the operation does not name its
 * document up front: a create, a bulk write, and a restore (whose `id` is the version's).
 */
export type OperationTarget = {
  collection: string;
  kind: OperationKind;
  id: DefaultDocumentIDType | undefined;
};

type Entry<Data> = {
  target: OperationTarget;
  req: object;
  trusted: boolean;
  data: Data;
  depth: number;
  parent: Entry<Data> | undefined;
};

/** Deeper chains come only from operations started synchronously in one turn; judge them untrusted. */
const MAX_DEPTH = 64;

const KINDS: Readonly<Partial<Record<string, OperationKind>>> = {
  create: "create",
  delete: "delete",
  restoreVersion: "update",
  update: "update",
};

/**
 * The identity of the request an operation runs for. Payload hands bulk documents and restores a
 * Proxy of `req`, so the request object itself is not stable across one operation's hooks; its
 * data loader is: Payload creates one per request and keeps it on nested Local API calls.
 */
export const requestKeyOf = (req: { payloadDataLoader?: unknown }): object =>
  typeof req.payloadDataLoader === "object" && req.payloadDataLoader !== null
    ? req.payloadDataLoader
    : req;

/** The kind of write a `beforeOperation` operation name performs, if it writes. */
export const operationKind = (operation: string) => KINDS[operation];

/**
 * An untrusted entry covers every document of its collection and kind: its `id` is as the caller
 * wrote it (`"05"` can find row 5), so an exact match could miss its own document and leave the
 * judgement to a trusted entry. Only trusted entries are narrowed to their id.
 */
const covers = (entry: Entry<unknown>, document: OperationTarget) =>
  entry.target.collection === document.collection &&
  entry.target.kind === document.kind &&
  (!entry.trusted ||
    entry.target.id === undefined ||
    document.id === undefined ||
    String(entry.target.id) === String(document.id));

/**
 * Per-operation records for the hooks of one operation, carried in an AsyncLocalStorage.
 *
 * An operation an app hook starts synchronously (an exported operation with
 * `disableTransaction: true`) runs its first `beforeOperation` hook in the caller's turn, so its
 * `enterWith` replaces the caller's store for the rest of the caller's operation; on Node 22 an
 * entry can also outlive its operation in a shared context. So no entry is ever trusted on its
 * own: each keeps the entry it replaced and the request it was opened for, and a document hook
 * reads every entry in its chain that covers its document under the same request (`requestKeyOf`). Several
 * covering entries (same-document nesting, a bulk write around a by-id write, a stale entry)
 * can only lower trust: the write is trusted only when all of them are, and callers judge every
 * entry's data. No covering entry means untrusted.
 */
export const createOperationScope = <Data>() => {
  const storage = new AsyncLocalStorage<Entry<Data>>();
  return {
    /** Call synchronously in the first `beforeOperation` hook. */
    open: (target: OperationTarget, req: object, trusted: boolean, data: Data) => {
      const parent = storage.getStore();
      storage.enterWith({ target, req, trusted, data, depth: (parent?.depth ?? 0) + 1, parent });
    },
    /** The entries covering one document under one request, innermost first. */
    lookup: (document: OperationTarget, req: object) => {
      const store = storage.getStore();
      const matches: Entry<Data>[] = [];
      for (let entry = store; entry !== undefined; entry = entry.parent) {
        if (entry.req === req && covers(entry, document)) {
          matches.push(entry);
        }
      }
      const [innermost] = matches;
      return innermost === undefined
        ? undefined
        : {
            trusted: (store?.depth ?? 0) <= MAX_DEPTH && matches.every((entry) => entry.trusted),
            innermost: innermost.data,
            // Trust is lowered by every covering entry; the data of an entry that names another
            // document is not this document's to judge.
            all: matches
              .filter(
                (entry) =>
                  entry === innermost ||
                  entry.target.id === undefined ||
                  document.id === undefined ||
                  String(entry.target.id) === String(document.id),
              )
              .map((entry) => entry.data),
          };
    },
  };
};
