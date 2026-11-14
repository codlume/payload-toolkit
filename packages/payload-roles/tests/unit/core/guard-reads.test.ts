// The users write hook loads only the roles `roleIdsRead` names. These tests walk editors,
// targets and bodies, and check for each that the decision reads no other role and comes out
// the same as with every role loaded.
import { expect, test } from "vitest";

import type { Capabilities, Grants } from "../../../src/contract.ts";
import { grantsOf, unionGrants } from "../../../src/grants.ts";
import {
  type Decision,
  decideUserWrite,
  roleIdsRead,
  type StoredUser,
} from "../../../src/guards.ts";

const fields = { rolesField: "roles", superAdminField: "superAdmin" };
const pagesRead = grantsOf(["collections:pages#read"]);
const pagesWrite = grantsOf(["collections:pages#read", "collections:pages#update"]);
const usersWrite = grantsOf(["collections:users#read", "collections:users#update"]);
/** Role 9 is held and sent below but names no role. */
const ROLES: ReadonlyMap<string, Grants> = new Map([
  ["1", pagesRead],
  ["2", pagesWrite],
  ["3", usersWrite],
]);
const ALL: Capabilities = { kind: "all" };
const EDITOR_ID = 10;

const editors: Capabilities[] = [
  ALL,
  { kind: "grants", grants: unionGrants([pagesWrite, usersWrite]) },
  { kind: "grants", grants: pagesRead },
  { kind: "grants", grants: grantsOf([]) },
];

const stored = (
  id: number,
  roleIds: number[],
  flags: Partial<Pick<StoredUser, "superAdmin" | "trashed">> = {},
): StoredUser => ({
  doc: { email: "t@example.com", id, roles: roleIds, superAdmin: flags.superAdmin ?? false },
  id,
  roleIds,
  superAdmin: false,
  trashed: false,
  ...flags,
});

const targets: (null | StoredUser)[] = [
  null,
  stored(EDITOR_ID, [1]),
  stored(20, []),
  stored(20, [1]),
  stored(20, [2, 3]),
  stored(20, [1, 9]),
  stored(20, [2], { superAdmin: true }),
  stored(20, [2], { superAdmin: true, trashed: true }),
];

const bodies: Record<string, unknown>[] = [
  {},
  { roles: [1] },
  { roles: [2] },
  { roles: ["1", 3] },
  { roles: [] },
  { roles: null },
  { roles: [9] },
  { roles: "1" },
  { superAdmin: true },
  { superAdmin: false },
  { superAdmin: "true" },
  { password: "new password" },
  { password: "" },
  { email: "t@example.com" },
  { email: "other@example.com" },
  { deletedAt: "2026-01-01" },
  { _verified: true },
  { password: "new password", roles: [2] },
  { email: "other@example.com", roles: [1] },
  { roles: [], superAdmin: false },
  { password: "new password", roles: "1" },
];

class TrackedGrants extends Map<string, Grants> {
  readonly reads = new Set<string>();

  override get(key: string) {
    this.reads.add(key);
    return super.get(key);
  }
}

type Case = {
  editor: Capabilities;
  raw: Record<string, unknown>;
  superAdminCount: number;
  target: null | StoredUser;
};

/** Judges one case with only `loaded` roles available, as the hook does, and records the reads. */
const judge = (
  { editor, raw, superAdminCount, target }: Case,
  loaded: ReadonlyMap<string, Grants>,
) => {
  const roleGrants = new TrackedGrants(loaded);
  const reads = new Set<string>();
  const capabilities: Capabilities = target?.superAdmin
    ? ALL
    : {
        kind: "grants",
        grants: unionGrants((target?.roleIds ?? []).flatMap((id) => loaded.get(String(id)) ?? [])),
      };
  const decision = decideUserWrite({
    editor,
    editorId: EDITOR_ID,
    fields,
    raw,
    roleGrants,
    superAdminCount,
    target: target && {
      ...target,
      get capabilities() {
        for (const id of target.roleIds) {
          reads.add(String(id));
        }
        return capabilities;
      },
    },
  });
  return { decision, reads: [...reads, ...roleGrants.reads] };
};

const cases: Case[] = editors.flatMap((editor) =>
  targets.flatMap((target) =>
    bodies.flatMap((raw) =>
      [1, 2].map((superAdminCount) => ({ editor, raw, superAdminCount, target })),
    ),
  ),
);

const named = ({ editor, raw, target }: Case) =>
  roleIdsRead({ editor, editorId: EDITOR_ID, fields, raw, target }).map(String);

test("a decision reads only the roles named for it, and matches the decision with every role loaded", () => {
  const outcomes = new Set<string>();
  let withoutRoles = 0;
  for (const current of cases) {
    const ids = named(current);
    const lazy = judge(current, new Map([...ROLES].filter(([id]) => ids.includes(id))));
    const eager = judge(current, ROLES);
    const label = JSON.stringify({ ...current, target: current.target?.doc ?? null });

    expect(ids, label).toEqual(expect.arrayContaining(lazy.reads));
    expect(ids, label).toEqual(expect.arrayContaining(eager.reads));
    expect(lazy.decision, label).toEqual(eager.decision);

    const decision: Decision = eager.decision;
    outcomes.add(decision.kind === "forbidden" ? decision.reason : decision.kind);
    withoutRoles += ids.length === 0 ? 1 : 0;
  }

  // The walk reaches every outcome the decision has, and both sides of the load.
  expect([...outcomes].toSorted()).toEqual([
    "allow",
    "invalid",
    "last-super-admin",
    "own-roles",
    "role-not-covered",
    "super-admin-field",
    "target-not-covered",
    "target-super-admin",
    "unknown-role",
  ]);
  expect(withoutRoles).toBeGreaterThan(0);
  expect(withoutRoles).toBeLessThan(cases.length);
});

test("a body that changes no role and no credential names no role", () => {
  for (const editor of editors) {
    for (const target of targets) {
      for (const raw of [{}, { email: "t@example.com" }, { roles: target?.roleIds ?? [] }]) {
        expect(roleIdsRead({ editor, editorId: EDITOR_ID, fields, raw, target })).toEqual([]);
      }
    }
  }
});

test("role changes and credential changes on another user name the roles they compare", () => {
  const [, member] = editors;
  const request = (raw: Record<string, unknown>, target: null | StoredUser) =>
    roleIdsRead({ editor: member ?? ALL, editorId: EDITOR_ID, fields, raw, target }).map(String);

  expect(request({ roles: [2, 9] }, stored(20, [1])).toSorted()).toEqual(["1", "2", "9"]);
  expect(request({ roles: [3] }, null)).toEqual(["3"]);
  expect(request({ password: "new password" }, stored(20, [2, 3]))).toEqual(["2", "3"]);
  expect(request({ password: "new password" }, stored(EDITOR_ID, [2, 3]))).toEqual([]);
  expect(
    roleIdsRead({
      editor: ALL,
      editorId: EDITOR_ID,
      fields,
      raw: { password: "new password" },
      target: stored(20, [2, 3]),
    }),
  ).toEqual([]);
});
