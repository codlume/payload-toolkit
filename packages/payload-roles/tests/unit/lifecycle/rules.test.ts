import { expect, test } from "vitest";

import type { ActionId } from "../../../src/contract.ts";
import {
  judge,
  type RequestView,
  requestFacts,
  requiredActions,
  type RulesResource,
  settleAfter,
  settleBefore,
} from "../../../src/lifecycle/rules.ts";

type Row = {
  id: string;
  resource: RulesResource;
  view: RequestView;
  before: null | Record<string, unknown>;
  final: Record<string, unknown>;
  floor: ActionId[];
  exact: ActionId[];
  reads: string;
};

const resource = (
  flags: Pick<RulesResource, "drafts" | "kind" | "trash">,
  actions: ActionId[],
): RulesResource => ({ ...flags, actions: new Set(actions) });

const pages = resource({ kind: "collection", drafts: true, trash: true }, [
  "read",
  "create",
  "update",
  "delete",
  "trash",
  "publish",
  "unpublish",
  "readVersions",
]);
const settings = resource({ kind: "global", drafts: true, trash: false }, [
  "read",
  "update",
  "publish",
  "unpublish",
  "readVersions",
]);
const plain = resource({ kind: "collection", drafts: false, trash: true }, [
  "read",
  "create",
  "update",
  "delete",
  "trash",
  "readVersions",
]);

const DATE = "2024-01-01T00:00:00.000Z";
const N = { _status: "draft", deletedAt: null };
const P = { _status: "published", deletedAt: null };
const TN = { _status: "draft", deletedAt: DATE };
const TP = { _status: "published", deletedAt: DATE };
const UNSAVED = {};

const view = (patch: Partial<RequestView>): RequestView => ({
  kind: "update",
  duplicate: false,
  bodyKeys: [],
  files: false,
  draft: false,
  trash: false,
  data: {},
  ...patch,
});

const row = (
  id: string,
  res: RulesResource,
  request: Partial<RequestView>,
  before: Row["before"],
  final: Row["final"],
  floor: ActionId[],
  exact: ActionId[],
  reads: string,
): Row => ({ id, resource: res, view: view(request), before, final, floor, exact, reads });

const ROWS: Row[] = [
  row(
    "C1 create draft",
    pages,
    { kind: "create", bodyKeys: ["title"], data: { title: "a" } },
    null,
    { _status: "draft" },
    ["create"],
    ["create"],
    "---",
  ),
  row(
    "C1 create draft:true with a published body",
    pages,
    { kind: "create", draft: true, bodyKeys: ["title", "_status"], data: { _status: "published" } },
    null,
    { _status: "draft" },
    ["create"],
    ["create"],
    "---",
  ),
  row(
    "C2 create published",
    pages,
    { kind: "create", bodyKeys: ["title", "_status"], data: { _status: "published" } },
    null,
    { _status: "published" },
    ["create", "publish"],
    ["create", "publish"],
    "---",
  ),
  row(
    "C3 duplicate of P, non-draft",
    pages,
    { kind: "create", duplicate: true, data: {} },
    null,
    { _status: "published" },
    ["create"],
    ["create", "publish"],
    "---",
  ),
  row(
    "C4 duplicate, draft",
    pages,
    {
      kind: "create",
      duplicate: true,
      draft: true,
      bodyKeys: ["_status"],
      data: { _status: "draft" },
    },
    null,
    { _status: "draft" },
    ["create"],
    ["create"],
    "---",
  ),
  row(
    "C5 create trashed",
    pages,
    { kind: "create", bodyKeys: ["title", "deletedAt"], data: { deletedAt: DATE } },
    null,
    { _status: "draft", deletedAt: DATE },
    ["create", "trash"],
    ["create", "trash"],
    "---",
  ),
  row(
    "U1 save draft on P",
    pages,
    { draft: true, bodyKeys: ["title", "_status"], data: { title: "b", _status: "draft" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "U1 autosave on PD",
    pages,
    { draft: true, bodyKeys: ["title"], data: { title: "b" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "U2 publish N, status-only",
    pages,
    { bodyKeys: ["_status"], data: { _status: "published" } },
    N,
    { _status: "published" },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "U2 publish PD, status-only",
    pages,
    { bodyKeys: ["_status"], data: { _status: "published" } },
    P,
    { _status: "published" },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "U2 publish N, draft:true with a published body",
    pages,
    { draft: true, bodyKeys: ["title", "_status"], data: { _status: "published" } },
    N,
    { _status: "published" },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "U3 non-draft content edit of P",
    pages,
    { bodyKeys: ["title"], data: { title: "c" } },
    P,
    { _status: "published" },
    ["update"],
    ["update", "publish"],
    "---",
  ),
  row(
    "U4 status-only unpublish of P",
    pages,
    { bodyKeys: ["_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    [],
    ["unpublish"],
    "rrr",
  ),
  row(
    "U4 status-only unpublish of PD",
    pages,
    { bodyKeys: ["_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    [],
    ["unpublish"],
    "rrr",
  ),
  row(
    "U5 content-bearing unpublish of P",
    pages,
    { bodyKeys: ["title", "_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update", "unpublish"],
    "-rr",
  ),
  row(
    "U6 implicit unpublish, {title} on PD",
    pages,
    { bodyKeys: ["title"], data: { title: "d" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update", "unpublish"],
    "-rr",
  ),
  row(
    "U6 implicit unpublish, {} on PD",
    pages,
    { bodyKeys: [], data: {} },
    P,
    { _status: "draft" },
    ["update"],
    ["update", "unpublish"],
    "-rr",
  ),
  row(
    "U7 status-only {_status: draft} on N",
    pages,
    { bodyKeys: ["_status"], data: { _status: "draft" } },
    N,
    { _status: "draft" },
    [],
    ["update"],
    "rrr",
  ),
  row(
    "U8 bulk non-draft {title} on PD, filled from the main row",
    pages,
    { bodyKeys: ["title"], data: { title: "e" } },
    P,
    { _status: "published" },
    ["update"],
    ["update", "publish"],
    "---",
  ),
  row(
    "T1 move to trash from N",
    pages,
    { bodyKeys: ["deletedAt"], data: { deletedAt: DATE } },
    N,
    { _status: "draft", deletedAt: DATE },
    ["trash"],
    ["trash"],
    "---",
  ),
  row(
    "T1 move to trash from P",
    pages,
    { bodyKeys: ["deletedAt"], data: { deletedAt: DATE } },
    P,
    { _status: "published", deletedAt: DATE },
    ["trash"],
    ["trash"],
    "---",
  ),
  row(
    "T1 move to trash from PD",
    pages,
    { bodyKeys: ["deletedAt"], data: { deletedAt: DATE } },
    P,
    { _status: "draft", deletedAt: DATE },
    ["trash"],
    ["trash"],
    "---",
  ),
  row(
    "T2 restore from trash as draft",
    pages,
    {
      trash: true,
      bodyKeys: ["deletedAt", "_status"],
      data: { deletedAt: null, _status: "draft" },
    },
    TP,
    { _status: "draft", deletedAt: null },
    [],
    ["trash"],
    "rrr",
  ),
  row(
    "T3 restore from trash as published",
    pages,
    {
      trash: true,
      bodyKeys: ["deletedAt", "_status"],
      data: { deletedAt: null, _status: "published" },
    },
    TN,
    { _status: "published", deletedAt: null },
    ["update", "publish"],
    ["update", "trash", "publish"],
    "--r",
  ),
  row(
    "T6 content edit of a trashed doc with ?trash=true",
    pages,
    { trash: true, bodyKeys: ["title"], data: { title: "f" } },
    TP,
    { _status: "published", deletedAt: DATE },
    ["update"],
    ["update"],
    "-rr",
  ),
  row(
    "T7 trash plus content edit of P",
    pages,
    { bodyKeys: ["title", "deletedAt"], data: { deletedAt: DATE } },
    P,
    { _status: "published", deletedAt: DATE },
    ["update", "trash"],
    ["update", "trash"],
    "---",
  ),
  row(
    "R1 restore a published version over N",
    pages,
    { kind: "restore" },
    N,
    { _status: "published" },
    ["update", "readVersions"],
    ["update", "publish", "readVersions"],
    "---",
  ),
  row(
    "R2 restore a draft version over P",
    pages,
    { kind: "restore" },
    P,
    { _status: "draft" },
    ["update", "readVersions"],
    ["update", "unpublish", "readVersions"],
    "---",
  ),
  row(
    "R3 restore with draft=true",
    pages,
    { kind: "restore", draft: true },
    P,
    { _status: "draft" },
    ["update", "readVersions"],
    ["update", "readVersions"],
    "---",
  ),
  row(
    "R4 restore a draft version over N",
    pages,
    { kind: "restore" },
    N,
    { _status: "draft" },
    ["update", "readVersions"],
    ["update", "readVersions"],
    "---",
  ),
  row(
    "G1 global save draft",
    settings,
    { draft: true, bodyKeys: ["siteName"], data: { siteName: "g" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "G2 global publish",
    settings,
    { bodyKeys: ["siteName", "_status"], data: { _status: "published" } },
    N,
    { _status: "published" },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "G2 global non-draft edit of a published global",
    settings,
    { bodyKeys: ["siteName"], data: { siteName: "h" } },
    P,
    { _status: "published" },
    ["update"],
    ["update", "publish"],
    "---",
  ),
  row(
    "G3 global status-only unpublish",
    settings,
    { bodyKeys: ["_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    [],
    ["unpublish"],
    "rrr",
  ),
  row(
    "G4 global restore of a published version",
    settings,
    { kind: "restore" },
    N,
    { _status: "published" },
    ["update", "readVersions"],
    ["update", "publish", "readVersions"],
    "n/a",
  ),
  row(
    "G5 global restore with draft=true over P",
    settings,
    { kind: "restore", draft: true },
    P,
    { _status: "draft" },
    ["update", "readVersions"],
    ["update", "unpublish", "readVersions"],
    "n/a",
  ),
  row(
    "G6 global restore of a draft version over N",
    settings,
    { kind: "restore" },
    N,
    { _status: "draft" },
    ["update", "readVersions"],
    ["update", "readVersions"],
    "n/a",
  ),
  row(
    "G7 first save of a never-saved global",
    settings,
    { bodyKeys: ["siteName"], data: { siteName: "i" } },
    UNSAVED,
    { _status: "draft" },
    ["update"],
    ["update"],
    "-rr",
  ),
  row(
    "X1 copy-to-locale on P",
    pages,
    {
      draft: true,
      bodyKeys: ["title", "_status", "deletedAt"],
      data: { _status: "published", deletedAt: null },
    },
    P,
    { _status: "published", deletedAt: null },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "X2 copy-to-locale on PD",
    pages,
    {
      draft: true,
      bodyKeys: ["title", "_status", "deletedAt"],
      data: { _status: "draft", deletedAt: null },
    },
    P,
    { _status: "draft", deletedAt: null },
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "J1 scheduled publish of N",
    pages,
    { bodyKeys: ["_status"], data: { _status: "published" } },
    N,
    { _status: "published" },
    ["update", "publish"],
    ["update", "publish"],
    "---",
  ),
  row(
    "J1 scheduled unpublish of P",
    pages,
    { bodyKeys: ["_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    [],
    ["unpublish"],
    "rrr",
  ),
  row(
    "NT1 no-drafts trash resource, move to trash",
    plain,
    { bodyKeys: ["deletedAt"], data: { deletedAt: DATE } },
    P,
    { deletedAt: DATE },
    ["trash"],
    ["trash"],
    "---",
  ),
  row(
    "NT2 no-drafts trash resource, restore from trash",
    plain,
    { trash: true, bodyKeys: ["deletedAt"], data: { deletedAt: null } },
    TP,
    { deletedAt: null },
    [],
    ["trash"],
    "-rr",
  ),
  row(
    "NT3 no-drafts resource, content edit",
    plain,
    { bodyKeys: ["title"], data: { title: "j" } },
    P,
    {},
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "NT4 no-drafts resource, restore a version",
    plain,
    { kind: "restore" },
    P,
    {},
    ["update", "readVersions"],
    ["update", "readVersions"],
    "---",
  ),
  row(
    "V1 draft save that sets deletedAt",
    pages,
    { draft: true, bodyKeys: ["title", "deletedAt"], data: { deletedAt: DATE } },
    P,
    { _status: "draft", deletedAt: DATE },
    ["update", "trash"],
    ["update", "trash"],
    "---",
  ),
  row(
    "V2 draft save with an explicit deletedAt: null",
    pages,
    {
      draft: true,
      bodyKeys: ["title", "deletedAt", "_status"],
      data: { deletedAt: null, _status: "draft" },
    },
    P,
    { _status: "draft", deletedAt: null },
    ["update"],
    ["update"],
    "---",
  ),
  row(
    "V3 draft restore of a trashed snapshot",
    pages,
    { kind: "restore", draft: true },
    P,
    { _status: "draft", deletedAt: DATE },
    ["update", "readVersions"],
    ["update", "trash", "readVersions"],
    "---",
  ),
  row(
    "V4 status-only draft save",
    pages,
    { draft: true, bodyKeys: ["_status"], data: { _status: "draft" } },
    P,
    { _status: "draft" },
    ["update"],
    ["update"],
    "---",
  ),
];

const ROLES = {
  "unpublish-only": ["read", "unpublish"],
  "update-only": ["read", "update"],
  "update+publish": ["read", "update", "publish"],
  "create-only": ["read", "create"],
  "trash-only": ["read", "trash"],
  "all-but-readVersions": ["read", "create", "update", "trash", "publish", "unpublish"],
} satisfies Record<string, ActionId[]>;

const READ_COLUMN = ["unpublish-only", "update-only", "update+publish"] as const;

const holding = (actions: readonly ActionId[]) => (action: ActionId) => actions.includes(action);

const requested = ({ resource: res, view: request }: Row) => requestFacts(res, request);

const settled = (entry: Row) => settleAfter(entry.resource, requested(entry), entry.final);

const exact = (entry: Row) =>
  entry.before === null
    ? settled(entry)
    : settleBefore(entry.resource, settled(entry), entry.before);

test.each(ROWS)("$id needs exactly $exact", (entry) => {
  expect([...requiredActions(entry.resource, exact(entry))]).toEqual(entry.exact);
});

test.each(ROWS)("$id has the access floor $floor before any row is read", (entry) => {
  expect([...requiredActions(entry.resource, requested(entry))]).toEqual(entry.floor);
});

test.each(ROWS.filter((entry) => entry.reads !== "n/a"))(
  "$id reads the main row only where the verdict depends on it ($reads)",
  (entry) => {
    const verdicts = READ_COLUMN.map((role) =>
      judge(entry.resource, settled(entry), holding(ROLES[role])).kind === "depends" ? "r" : "-",
    );
    expect(verdicts.join("")).toBe(entry.reads);
  },
);

test("the floor is a subset of the exact set on every row", () => {
  for (const entry of ROWS) {
    const precise = requiredActions(entry.resource, exact(entry));
    for (const action of requiredActions(entry.resource, requested(entry))) {
      expect(precise.has(action), `${entry.id}: floor ${action} is not in the exact set`).toBe(
        true,
      );
    }
  }
});

test("draft saves, autosaves, copy-to-locale drafts and draft restores never depend on the main row", () => {
  const versionOnly = ROWS.filter((entry) => /^(U1|G1|X2|R3|V)/u.test(entry.id));
  expect(versionOnly.length).toBeGreaterThanOrEqual(8);
  for (const entry of versionOnly) {
    for (const [role, actions] of Object.entries(ROLES)) {
      expect(
        judge(entry.resource, settled(entry), holding(actions)).kind,
        `${entry.id} for ${role}`,
      ).not.toBe("depends");
    }
  }
});

test("complete facts never yield depends", () => {
  for (const entry of ROWS) {
    for (const [role, actions] of Object.entries(ROLES)) {
      expect(
        judge(entry.resource, exact(entry), holding(actions)).kind,
        `${entry.id} for ${role}`,
      ).not.toBe("depends");
    }
  }
});

test("the pre-access check never denies a write the final judge would allow", () => {
  for (const entry of ROWS) {
    for (const [role, actions] of Object.entries(ROLES)) {
      const holds = holding(actions);
      if (judge(entry.resource, exact(entry), holds).kind === "allow") {
        expect(
          judge(entry.resource, requested(entry), holds).kind,
          `${entry.id}: pre-access denies ${role}`,
        ).not.toBe("deny");
      }
    }
  }
});

test("a denial names what the editor lacks", () => {
  const unpublishOfP = ROWS.find((entry) => entry.id === "U4 status-only unpublish of P");
  if (!unpublishOfP) {
    throw new Error("row missing");
  }
  expect(judge(pages, exact(unpublishOfP), holding(ROLES["update-only"]))).toEqual({
    kind: "deny",
    missing: ["unpublish"],
  });
});

const probe = (
  res: RulesResource,
  key: "create" | "update",
  data: Record<string, unknown> | undefined,
) => [...requiredActions(res, requestFacts(res, view({ kind: key, bodyKeys: null, data })))];

test("admin probes, which carry no client body, ask for the stock controls' actions", () => {
  expect(probe(pages, "update", { title: "x", _status: "draft" })).toEqual(["update"]);
  expect(probe(pages, "update", { title: "x", _status: "published" })).toEqual([
    "update",
    "publish",
  ]);
  expect(probe(pages, "update", { title: "x", _status: "draft", deletedAt: DATE })).toEqual([
    "update",
    "trash",
  ]);
  expect(probe(pages, "update", undefined)).toEqual(["update"]);
  expect(probe(pages, "create", { _status: "draft" })).toEqual(["create"]);
  expect(probe(pages, "create", { _status: "published" })).toEqual(["create", "publish"]);
  expect(probe(settings, "update", undefined)).toEqual(["update"]);
});
