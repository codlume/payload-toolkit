// Run: pnpm --filter @codlume/payload-roles build && pnpm --filter @codlume/payload-roles exec vitest bench tests/integration/admin/load-model.bench.ts --run
// Times the permissions field's server render (editor resolution, copy sources, assignment
// count, model) against in-memory SQLite holding ROLES roles, as a member and as a super admin.
import { createLocalReq } from "payload";
import { afterAll, bench, describe, vi } from "vitest";

import { PermissionsField, UnpublishControl, UnpublishSlot } from "@codlume/payload-roles";

import { fresh, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload } from "../../helpers/payload.ts";

vi.mock("@codlume/payload-roles/client", () => ({
  PermissionsMatrix: () => null,
  UnpublishDocument: () => null,
}));
vi.mock("@payloadcms/ui", () => ({ UnpublishButton: () => null }));

const ROLES = 200;

const context = await createTestPayload({ name: "admin-load-model-bench" });
const { payload } = context;
const actions = ["read", "update", "publish", "unpublish", "readVersions"];
const editorRole = await seedRole(payload, "bench-editor", {
  collections: {
    pages: { actions },
    posts: { actions: ["read", "update"] },
    roles: { actions: ["read", "create", "update"] },
    users: { actions: ["read", "update"] },
  },
  globals: { settings: { actions } },
});
const roleIds = await Promise.all(
  Array.from({ length: ROLES }, (_, index) =>
    seedRole(payload, `bench-role-${index}`, {
      collections: {
        pages: { actions: actions.slice(0, 1 + (index % actions.length)) },
        posts: { actions: ["read"] },
      },
      globals: { settings: { actions: ["read"] } },
    }),
  ),
);
// The first user becomes the super admin, so it is seeded before the member.
const superAdmin = await seedUser(payload, { email: "bench-super@example.com", superAdmin: true });
const member = await seedUser(payload, { email: "bench-editor@example.com", roles: [editorRole] });
const target = roleIds[0] ?? editorRole;
const value = (await payload.findByID({ collection: "roles", depth: 0, id: target })).permissions;

const render = async (actor: { id: number | string }) => {
  const req = await createLocalReq({ user: await fresh(payload, actor.id) }, payload);
  const element = await PermissionsField({
    clientField: { name: "permissions", type: "json" },
    id: target,
    path: "permissions",
    readOnly: false,
    req,
    value,
  });
  const props: unknown = element.props;
  if (typeof props !== "object" || props === null || !("model" in props)) {
    throw new Error("no model rendered");
  }
  return props.model;
};

const page = await payload.create({
  collection: "pages",
  data: { _status: "published", title: "Bench" },
});
const viewerProp = async (actor: { id: number | string }) => ({
  ...(await payload.findByID({ collection: "users", depth: 2, id: actor.id })),
  collection: "users",
});

const { i18n } = await createLocalReq({}, payload);

type Viewer = Awaited<ReturnType<typeof viewerProp>>;

/** One document view renders both Unpublish slots with the same `user` prop object. */
const documentView = async (user: Viewer) => {
  const props = { id: page.id, i18n, payload, resource: "collections:pages" as const, user };
  await Promise.all([UnpublishSlot(props), UnpublishControl(props)]);
};

const countQueries = async (work: () => Promise<unknown>) => {
  const spies = [vi.spyOn(payload.db, "findOne"), vi.spyOn(payload.db, "find")];
  try {
    await work();
    return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) {
      spy.mockRestore();
    }
  }
};

const first = await render(member);
const memberViewer = await viewerProp(member);
process.stdout.write(
  `[metrics] ${JSON.stringify({
    roles: ROLES,
    memberModelBytes: JSON.stringify(first).length,
    documentViewQueries: await countQueries(() => documentView(memberViewer)),
  })}\n`,
);

describe(`permissions field server render, ${ROLES} roles`, () => {
  afterAll(() => context.destroy());

  bench("member editor", async () => {
    await render(member);
  });

  bench("super admin", async () => {
    await render(superAdmin);
  });

  // A fresh prop object per view, as Payload creates per request, so no view reuses another's.
  bench("unpublish slots, one document view (member)", async () => {
    await documentView({ ...memberViewer });
  });
});
