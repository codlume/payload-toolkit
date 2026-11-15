import { expect, test } from "vitest";

import { planUnpublish } from "../../../src/admin/server/unpublish-plan.ts";
import type { ActionId, ResourceId, Subject } from "../../../src/contract.ts";
import { grantId, grantsOf } from "../../../src/grants.ts";

const resource: ResourceId = "collections:pages";

const member = (...actions: ActionId[]): Subject => ({
  kind: "member",
  id: 1,
  capabilities: {
    kind: "grants",
    grants: grantsOf(actions.map((action) => grantId(resource, action))),
  },
});

const cases: [string, boolean, Subject, ReturnType<typeof planUnpublish>][] = [
  ["read+unpublish", true, member("read", "unpublish"), { slot: "none", control: true }],
  ["update+publish", true, member("read", "update", "publish"), { slot: "none", control: false }],
  [
    "update+publish+unpublish",
    true,
    member("read", "update", "publish", "unpublish"),
    { slot: "none", control: true },
  ],
  ["update only", true, member("read", "update"), { slot: "none", control: false }],
  [
    "super admin",
    true,
    { kind: "member", id: 1, capabilities: { kind: "all" } },
    { slot: "none", control: true },
  ],
  ["outsider", true, { kind: "outsider" }, { slot: "stock", control: false }],
  ["disabled", false, member("read", "unpublish"), { slot: "stock", control: false }],
];

test.each(cases)("%s gets the expected Unpublish placement", (_name, enabled, subject, plan) => {
  const result = planUnpublish({ enabled, subject, resource });
  expect(result).toEqual(plan);
  expect(result.slot === "stock" && result.control).toBe(false);
});

test("an unpublish grant on another resource offers no control", () => {
  const other: Subject = {
    kind: "member",
    id: 1,
    capabilities: { kind: "grants", grants: grantsOf([grantId("globals:settings", "unpublish")]) },
  };
  expect(planUnpublish({ enabled: true, subject: other, resource })).toEqual({
    slot: "none",
    control: false,
  });
});
