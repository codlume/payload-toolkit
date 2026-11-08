# Payload roles: core handoff to the lifecycle and matrix threads

The core commit of `@codlume/payload-roles` provides the roles collection, user fields, role resolution, access composition and escalation guards. It does not enforce publish, unpublish, trash or restore precisely. Two threads build on it in parallel, each in its own worktree:

- **Lifecycle.** Server-side classification of draft saves, publish, unpublish, trash and restore.
- **Matrix.** The permissions matrix field and the Unpublish controls in the admin.

Read [the feasibility gates](payload-roles-feasibility.md) before you start. They record what Payload actually does, and three of the planned mechanisms were disproved.

## File ownership

No file has two writers. A file that core seeded belongs to its new owner from the handoff on. Core never edits it again.

| Path                                                                                                                                                                                                                            | Owner                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `packages/payload-roles/package.json`, `vite.config.ts`, `tsconfig.json`, `README.md`, `LICENSE`                                                                                                                                | core                     |
| `packages/payload-roles/src/*.ts` (all top-level source files)                                                                                                                                                                  | core                     |
| `packages/payload-roles/src/lifecycle/index.ts` (seeded with the interim rule)                                                                                                                                                  | lifecycle                |
| `packages/payload-roles/src/lifecycle/**`                                                                                                                                                                                       | lifecycle                |
| `packages/payload-roles/tests/unit/lifecycle/**`, `tests/integration/lifecycle/**` (seeded `interim.test.ts`, which you may delete)                                                                                             | lifecycle                |
| `packages/payload-roles/src/admin/index.ts`, `src/admin/server.ts`, `src/admin/client.ts` (seeded stubs)                                                                                                                        | matrix                   |
| `packages/payload-roles/src/admin/**`                                                                                                                                                                                           | matrix                   |
| `packages/payload-roles/tests/unit/admin/**`, `tests/integration/admin/**`, `tests/build/admin-*.test.mjs`                                                                                                                      | matrix                   |
| `packages/payload-roles/tests/helpers/**`, `tests/unit/core/**`, `tests/integration/core/**`, `tests/build/package-contract.test.mjs`, `tests/compat/run.mjs`                                                                   | core                     |
| `pnpm-lock.yaml`, `apps/payload-cms/**` (demo wiring, `importMap.js`, generated types), `tests/compat/**` at the repo root, `.dockerignore`, `release-please-config.json`, root `README.md`, `docs/research/payload-roles-*.md` | core (final integration) |

If you need a new dependency, a new export entry, README text or a demo change, write it in your pull request description. Core applies it at integration. Do not edit core files from a dependent branch. If the contract in `src/contract.ts` blocks you, report the exact missing seam. Changing the contract takes a core commit that both threads rebase onto.

## The contract

Everything a dependent needs from core comes from `src/contract.ts` (types plus `enforcerOf`), `src/grants.ts` and `src/registry.ts`. Import other core modules only when you must, and never rely on their internals.

- `ACTION_IDS` and `ActionId` list the nine actions: read, create, update, delete, trash, publish, unpublish, readVersions, unlock.
- `Resource` gives the flags of one managed collection or global, plus `actions`, the set of actions that apply to it. `Registry` maps `ResourceId` (`collections:<slug>` or `globals:<slug>`) to `Resource`, in config order.
- `Grants` is a branded set of `` `${ResourceId}#${ActionId}` `` cells. `Capabilities` is `{kind: "all"}` (super admin) or `{kind: "grants", grants}`. `Subject` is `{kind: "outsider"}` (anonymous or another auth collection) or `{kind: "member", id, capabilities}`.
- `Enforcer` is `{options, registry, subject(req), log}`, stored on the server-only `config.custom["@codlume/payload-roles"]`. Call `enforcerOf(payload)` to recover it. `subject(req)` is memoized per `req.user` object with a 5 s TTL.
- `can(capabilities, resourceId, action)`, `covers(outer, inner)` and `missingFrom(grants, capabilities)` in `src/grants.ts` answer every "may this editor" question. Do not reimplement them.
- `parsePermissions(raw, registry)` is the read boundary. It never throws, drops invalid cells and returns `{ grants, issues }`. `checkPermissions(raw, registry, editor)` is the write boundary and returns the same `{ grants, issues }` shape. Each `CellIssue` has a field `path`, `resource`, `action` and `reason`: `malformed`, `unknown-resource`, `unknown-action`, `inapplicable`, `requires-update` (v1: publish needs update) or `not-held` (the editor lacks the cell). The roles guard throws the issues as a Payload `ValidationError` on the `permissions` path.
- The roles guard also refuses, with `Forbidden`, any update, restore or delete of a role (by id or in bulk) by a non-super-admin who does not hold every cell the role grants now. This revises plan section 8: deleting or shrinking a role can strip a stronger user down to what the editor covers, after which the editor may change that user's credentials.
- `resolveOptions` rejects a user collection with `versions.drafts`. The lifecycle thread never sees a drafts user collection.

### Lifecycle seam

`src/lifecycle/index.ts` exports `lifecycle: LifecycleModule`:

- `enforcing` is shown in the startup log. Set it to `true` only when your hooks enforce every transition in plan section 6.
- `requiredWriteActions(args)` is called from core's create and update access wrappers. A write is allowed when the editor holds every returned action that applies to the resource. Returning more is always safe. Return less than the interim rule only where your hooks enforce the difference.
- `collectionHooks(resource, enforcer)` and `globalHooks(resource, enforcer)` return hook arrays. Core appends them after the app's hooks and its own on every managed drafts-or-not resource, and `onInit` fails startup if a later plugin pushes hooks behind them.
- Both may also return `leadingBeforeOperation`, one synchronous callback, not a hook array. Core calls it from the opener described below. It may only open your own `AsyncLocalStorage` store with `enterWith` and copy raw `args` (for example `Object.keys(args.data)`). It is typed to return `undefined`, so an `async` callback does not typecheck. Anything that awaits goes in `beforeOperation`, which runs after the app's hooks and may fill the store you opened.

Core's own hooks sit on the users and roles collections only. Payload awaits each `beforeOperation` hook in turn, so only an `enterWith` made in the first hook reaches the operation's later hooks. Core therefore installs exactly one first `beforeOperation` hook, the opener, on the users collection (managed or not) and the roles collection while enforcement is enabled, and on every managed collection and global where you return `leadingBeforeOperation`. The opener synchronously runs core's recorder, which calls `enterWith` on core's own `AsyncLocalStorage` with the trust verdict and the privileged keys as the client sent them, then calls your callback, and returns `undefined` so Payload's args stand. The guards run in `beforeChange` and `beforeDelete`, after the app's hooks, once per document, and read the target with `payload.db.findOne`. The bootstrap follows the users guard in `beforeChange`. Core installs `[opener, ...app, ...lifecycle.beforeOperation]` on `beforeOperation`, `[...app, ...core, ...lifecycle]` on `beforeChange`, and `onInit` checks both ends. That check also requires your trailing hooks to stay last, so a later plugin that appends a `beforeOperation` hook to a collection where you add trailing ones fails startup. Say so in your pull request. `tests/integration/core/seam.test.ts` pins the behavior: a store opened in `leadingBeforeOperation` reaches `beforeChange` on users, roles, `pages` and the `settings` global behind an app hook that awaits.

The opener takes first place from app hooks. On users and roles that is always so; on any other managed resource it is so once you return `leadingBeforeOperation`. An app or third-party `beforeOperation` hook there that relies on its own `enterWith` no longer reaches the operation's later hooks. The README lists this as a limitation; mention it in your pull request if you return the callback.

Core's guards read their record with `operations.getStore() ?? untrusted()`, where `untrusted()` builds a fresh record per call. No Payload 3.90.1 path reaches those guards without the opener, so this is not reachable today. But if the store were missing, every document of a bulk would get its own record, and per-operation state such as the super admin tally would never carry across documents. Do not copy that pattern: when your store is missing, refuse the write.

Core's interim rule is fail-closed. Create on a drafts resource needs `create + publish`, unless `data._status === 'draft'`. Update needs `update`, plus `publish + unpublish` on drafts resources, `trash` on trash-enabled resources when the body carries `deletedAt`, and `readVersions` on versioned resources when the body has only `_status` (restore and status-only bodies). Delete with `deletedAt` needs `trash`; otherwise it needs `delete`.

What the gates require of the lifecycle design:

- Carry Intent with `AsyncLocalStorage.enterWith`, called synchronously at the top of `beforeOperation`. A `WeakMap<req>` stack leaks trusted frames (G1). `afterError` does not run inside operations. One gap in G1, measured on Node 24.21.0 in core's rounds 3 and 4: the operation's `await` on its `beforeOperation` loop captures its context during the first hook's synchronous run, so an `enterWith` in any later hook, even right behind a synchronous one, never reaches `beforeChange`. Put your `enterWith` in `leadingBeforeOperation`, which core calls from the opener, the first hook, on collections and globals. Hooks in `beforeOperation` come after the app's and can fill the store you opened there. Still fail closed in later hooks when the store is missing. Use your own `AsyncLocalStorage` instance; core's is module-private.
- Compute `writesMain` from raw request flags captured in `beforeOperation`. Copy `Object.keys(data)` there, because `args.data` is filled in place later (G3, G7).
- On upload collections, deny in `beforeOperation`, because update writes files before `beforeChange` (G18).
- Read the main row's `_status` with `payload.db.findOne` for the "before" state, never `originalDoc` (G2, G3). Concurrency races exist on SQLite, standalone Mongo, and Postgres without `FOR UPDATE` (G2). Document them; do not claim atomicity.
- Decide global restore in `beforeOperation`. It runs no field hooks, and the Local API drops `draft` (G4).
- Duplicate copies `_status: 'published'` unless it is a draft save. Keep a create-side check (G13).
- Restore from trash is a bulk PATCH with `?trash=true` (G12, G19). Bulk always commits the permitted documents (G20).
- GraphQL has `autosave` on collection update only. Globals have none, and there is no unpublish flag or bulk update.
- Trust: for privileged decisions, core treats a call as trusted only when `overrideAccess === true` and `req.payloadAPI === 'local'` (G14). The lifecycle thread may treat any `overrideAccess: true` operation as trusted, since that is Payload's documented contract. Say which rule you chose.

### Matrix seam

`src/admin/index.ts` exports `admin: AdminModule`:

- `permissionsField` holds the components for the roles collection's `permissions` JSON field. `undefined` keeps Payload's JSON editor.
- `collectionEdit(resource)` and `globalElements(resource)` return edit-view slot components for managed resources, for example a replacement `UnpublishButton` and a `beforeDocumentControls` control. `undefined` keeps the stock UI.

Server components go in `src/admin/server.ts`. They are re-exported from the package root, so their import-map strings are `@codlume/payload-roles#Name`. Client components go in `src/admin/client.ts` (`@codlume/payload-roles/client#Name`). A server component that renders a client component must load it with a deferred `await import("@codlume/payload-roles/client")` inside the component. A static import is refused by `tests/build/package-contract.test.mjs`: the client entry reaches CSS through `@payloadcms/ui` and cannot load in plain Node, where Payload configs also load. The specifier is kept external by core's `vite.config.ts`. Resolve the editor with `enforcerOf(payload).subject(req)`, using the request object. The `user` prop that `initReq` passes is field-filtered and misses the memo (G6). Build matrix rows from `registry` and `resource.actions`, and disable a cell when `can(editor, resource.id, action)` is false. Map save errors from the `ValidationError` paths that `checkPermissions` produces.

## Commands

Run from the repository root with Node 24 (`.node-version` is 24.13.1; any 24.x that satisfies `engines` works):

```sh
pnpm install --frozen-lockfile
pnpm --filter @codlume/payload-roles test:unit
pnpm --filter @codlume/payload-roles test:integration
pnpm --filter @codlume/payload-roles test:build
pnpm typecheck && pnpm lint && pnpm fmt:check
```

`node packages/payload-roles/tests/compat/run.mjs <version>` runs the unit and integration suites against another Payload 3.x release in a disposable copy. Payload 3.92.0 and later need Node `^22.23.4 || >=24.22.1`.

Reuse `tests/helpers` for fixtures. It provides:

- `createTestPayload({ name, collections?, globals?, roles?, plugins? })` in `payload.ts`: in-memory SQLite that returns a `TestPayload` (`{ payload, config, key, logs, destroy }`). The default fixtures from `fixtureCollections()` are `users` (auth), `pages` (drafts and trash), `posts` (public `read`) and `notes` (an app `read` `Where` and `update: () => false`); `fixtureGlobals()` is the `settings` global with drafts. `defaultRolesOptions()` manages all of them, with `debug: true`. `createTestConfig` builds the config without starting Payload.
- `seedRole(payload, key, permissions)` and `seedUser(payload, { email, roles?, superAdmin?, password? })` in `actors.ts`, both trusted Local API writes. `fresh(payload, id)` rereads a user as a new object, so the capability memo does not serve a stale answer. `PASSWORD` is the default password.
- `as(payload, user)` for Local API calls with `overrideAccess: false`. `update` and `delete` take an id; `updateMany` and `deleteMany` take a `where`.
- `login(payload, email, password?)` returns a JWT. `rest(context, token)` takes the `TestPayload` and returns `(method, path, body?) => Promise<{ status, json }>`, run through `handleEndpoints`. `graphql(context, token, query, variables?)` runs a query against `configToSchema`.
- `rejectsWith(promise, name)` for asserting the error name (`Forbidden`, `NotFound` or `ValidationError`) and `validationPaths(promise)` for the paths of a `ValidationError`, both in `expect.ts`.

Your tests must keep the core suites green. The seeded `tests/integration/lifecycle/interim.test.ts` pins the interim rule. Replace it when your rule supersedes it.

## Not in core, by decision

- Precise publish, unpublish, trash and restore enforcement belongs to the lifecycle thread.
- The matrix UI and the Unpublish controls belong to the matrix thread.
- Demo wiring, import map, compat lane registration and release registration happen at final integration. The repo-wide compat lanes still pin Payload 3.88.0, which is below this package's floor, so registering there needs a lane decision first.
- The package stays `private: true` at `0.0.0` and unregistered in `release-please-config.json` until the full plugin is ready. Publishing an incomplete security plugin is the risk this avoids.
- M4 (field rules, row conditions) and M5 (queue-time scheduling check, `localizeStatus`, approver UI, bulk-control hiding) stay deferred.
