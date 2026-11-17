# Roles and permissions

`@codlume/payload-roles` adds database-backed roles to a Payload app. A role grants actions per collection or global (`read`, `create`, `update`, `delete`, `trash`, `publish`, `unpublish`, `readVersions`, `unlock`). Grants are intersected with the app's own access functions, and escalation guards stop users from granting themselves more than they hold. The demo app does not install this plugin yet, so verification runs through the package's integration suite, which boots real Payload and sends REST, GraphQL, and Local API requests.

## Sub-features

- `roles-bootstrap` makes the first user a super admin.
- `roles-access` computes access as role grants AND the app's access function.
- `roles-escalation` refuses to change your own roles, grant a role you do not fully hold, or edit a user you do not cover.
- `roles-last-super-admin` refuses to demote, trash, or delete the last active super admin.
- `roles-lifecycle` requires `publish`, `unpublish`, `trash`, and `readVersions` for those moves, and leaves stored data unchanged on refusal.
- `roles-matrix` edits a role's permissions in the Admin matrix field (`Permissions by resource and action`).
- `roles-unpublish-control` shows the Unpublish control only to users with the `unpublish` grant.
- `roles-config` rejects invalid plugin options with one `RolesPluginConfigError`.

## How to get to it (user POV)

- An app developer adds `rolesPlugin({ collections, globals })` to a Payload config.
- An admin edits roles at `/admin/collections/roles/<id>` and assigns them in the user sidebar.
- A member's REST and GraphQL requests are allowed or refused with 403.

## Driving it with vitest

Preconditions:

- `pnpm --filter @codlume/payload-roles build`. The tests import `dist`. Do not rebuild while another run of the suite is using `dist`.
- No Docker is needed. Each test boots Payload on in-memory SQLite.

- **Whole package.** `pnpm --filter @codlume/payload-roles test:unit` and `pnpm --filter @codlume/payload-roles test:integration`. The integration suite runs serially and takes several minutes.
- **One area.** `pnpm --filter @codlume/payload-roles exec vitest run tests/integration/core/escalation.test.ts`. Areas: `tests/integration/core` (access, guards, bootstrap, trash), `tests/integration/lifecycle` (publish, unpublish, trash, restore), `tests/integration/admin` (matrix field, unpublish control), `tests/unit/lifecycle/rules.test.ts` (the transition table).
- **Randomized lifecycle sweep.** `LIFECYCLE_SWEEP_SEQUENCES=500 LIFECYCLE_SWEEP_SEED=1 pnpm --filter @codlume/payload-roles exec vitest run tests/integration/lifecycle/sweep.test.ts`. It prints a replay line for each violation.
- **Admin matrix and unpublish UI.** `pnpm --filter @codlume/payload-roles exec vitest run tests/unit/admin`. These are jsdom tests. No browser surface exists until an app installs the plugin.
- **Proof.** Save the vitest summary lines (`Test Files`, `Tests`) for each suite the change touches.

## Gotchas

- Capabilities are cached for 5 s per user object. In Local API checks, reload the user before asserting a changed grant.
- The last-super-admin guard is not atomic under concurrent requests. The README documents this limit, so a concurrent repro is not a regression.
- Trusted writes (`overrideAccess: true`), super admins, and outsiders skip lifecycle checks. Test refusals as a member through `rest` or `as` with a user.
- The state models are in `docs/statecharts/roles-guards.md` and `docs/statecharts/document-lifecycle.md`.
