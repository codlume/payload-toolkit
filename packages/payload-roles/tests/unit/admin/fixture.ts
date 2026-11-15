import type { Capabilities, Grant } from "../../../src/contract.ts";
import { grantsOf } from "../../../src/grants.ts";
import { buildRegistry } from "../../../src/registry.ts";
import { matrixModelOf, type ModelInput } from "../../../src/admin/server/build-model.ts";

export const registry = buildRegistry(
  {
    collections: [
      { auth: true, slug: "users" },
      { slug: "pages", trash: true, versions: { drafts: true } },
      { slug: "posts" },
      { slug: "roles", versions: true },
    ],
    globals: [{ slug: "settings", versions: { drafts: true } }],
  },
  { collections: ["users", "pages", "posts"], globals: ["settings"], rolesSlug: "roles" },
);

export const ALL: Capabilities = { kind: "all" };

export const holding = (...cells: Grant[]): Capabilities => ({
  kind: "grants",
  grants: grantsOf(cells),
});

export const modelOf = (input: Partial<ModelInput> = {}) =>
  matrixModelOf({
    registry,
    options: { enabled: true, rolesSlug: "roles", userCollection: "users" },
    labels: new Map(),
    editor: ALL,
    readOnly: false,
    existing: true,
    path: "permissions",
    value: {},
    copySources: [],
    assignment: null,
    ...input,
  });
