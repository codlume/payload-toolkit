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
  /** Set once the id Payload acts on is known, after the app's `beforeOperation` hooks. */
  settled: boolean;
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

const UUID = /^\{?[\da-f]{8}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{4}-?[\da-f]{12}\}?$/u;

const idForm = (id: DefaultDocumentIDType) => {
  const text = String(id).trim().toLowerCase();
  const number = Number(text);
  if (Number.isFinite(number)) {
    return `number:${number}`;
  }
  return UUID.test(text) ? `uuid:${text.replaceAll(/[{}-]/gu, "")}` : `text:${text}`;
};

/**
 * Whether two ids may name the same document. Payload resolves many spellings of one id: `"05"`,
 * `"5e0"` and `".5e1"` all find row 5, a blank id finds row 0, and a uuid matches in any case.
 * This over-matches, also accepting uuid spellings Payload rejects, because a match can only add
 * an entry to the judgement.
 */
const maybeSameId = (a: DefaultDocumentIDType, b: DefaultDocumentIDType) => idForm(a) === idForm(b);

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
    /**
     * Call synchronously in the first `beforeOperation` hook. App `beforeOperation` hooks run
     * after it and may change `args.id`, so call the returned `settle` from a `beforeOperation`
     * hook that runs after them, with the id Payload will act on.
     */
    open: (target: OperationTarget, req: object, trusted: boolean, data: Data) => {
      const parent = storage.getStore();
      const entry: Entry<Data> = {
        target,
        settled: false,
        req,
        trusted,
        data,
        depth: (parent?.depth ?? 0) + 1,
        parent,
      };
      storage.enterWith(entry);
      // An entry opened without an id names every document; nothing an app hook does to
      // `args.id` afterwards narrows it, since Payload's bulk and restore paths ignore that id.
      return (id: DefaultDocumentIDType | undefined) => {
        entry.target = { ...entry.target, id: target.id === undefined ? undefined : id };
        entry.settled = true;
      };
    },
    /**
     * When an operation's own `settle` cannot be found, makes every unsettled entry of that
     * collection and kind under the request that names a document other than `id` name every
     * document, so its data is judged on all of them.
     */
    widen: (
      collection: string,
      kind: OperationKind,
      req: object,
      id: DefaultDocumentIDType | undefined,
    ) => {
      let ownFound = false;
      for (let entry = storage.getStore(); entry !== undefined; entry = entry.parent) {
        const { target } = entry;
        if (
          entry.settled ||
          entry.req !== req ||
          target.collection !== collection ||
          target.kind !== kind ||
          target.id === undefined
        ) {
          continue;
        }
        if (id !== undefined && maybeSameId(target.id, id)) {
          // The innermost unsettled entry that already names the final document is the
          // operation's own: nested operations started before this point settled themselves.
          if (!ownFound) {
            ownFound = true;
            entry.settled = true;
          }
          continue;
        }
        entry.target = { ...target, id: undefined };
        entry.settled = true;
      }
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
      if (innermost === undefined) {
        return undefined;
      }
      // An entry that names another document lowers `trusted` but is not this document's to
      // judge, so `all` keeps only the entries that may name this document. That narrowing is
      // never a trust verdict; it relies on `settle` or `widen` having replaced an id that an
      // app `beforeOperation` hook changed after the entry was opened.
      const named = matches.filter(
        (entry) =>
          entry === innermost ||
          entry.target.id === undefined ||
          document.id === undefined ||
          maybeSameId(entry.target.id, document.id),
      );
      return {
        trusted: (store?.depth ?? 0) <= MAX_DEPTH && matches.every((entry) => entry.trusted),
        innermost: innermost.data,
        all: named.map((entry) => entry.data),
      };
    },
  };
};
