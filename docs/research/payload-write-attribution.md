# Write attribution mechanics in Payload 3.88 hooks

Research for [issue #39](https://github.com/codlume/payload-toolkit/issues/39):
how a plugin reliably reads the acting user on every write to a collection or
global so it can set a `lastModifiedBy` relationship (or null). All claims below
were verified against the `payload@3.88.0` package in this workspace's
node_modules (paths given as `payload/dist/...`) and against the BlurHash plugin
at `packages/payload-blurhash/src/plugin.ts`.

## Answer

A field-level `beforeChange` hook on an injected relationship field, combined
with field access `create: () => false, update: () => false`, is the reliable
mechanism — for collections and globals alike. Both write paths run the same
shared field traversal (`beforeValidate` then `beforeChange`), field access
filtering strips caller-supplied values before the field hook runs, the hook's
return value always lands, and drafts/autosave/version writes copy the
already-hooked document rather than re-running or bypassing hooks. The hook
should read `req.user`, attribute only when `user.collection ===
payload.config.admin.user`, and return `null` otherwise (Local API and jobs run
with `req.user = null` by default). The BlurHash plugin's field pattern carries
over to globals unchanged, with one difference: `args.collection` is `null` and
`args.global` is set, and `operation` is always `'update'` for globals.

## 1. `req.user` shape and its `collection` property

- The server-side user type requires `collection: string` alongside `id`,
  optional `email`/`username`/`sessions` — `BaseUser` in
  `payload/dist/auth/types.d.ts:92-98`, extended by `UntypedUser`/`ClientUser`
  as `{ [key: string]: any } & BaseUser`. A doc comment notes `collection` is
  server-only: "`collection` is not available on the client. It's only
  available on the server (req.user)" (`payload/dist/auth/types.d.ts:106-107`).
- Auth strategies set `collection` to the auth collection's slug when they
  build the user: JWT strategy sets `collection: collection.config.slug`
  (`payload/dist/auth/strategies/jwt.js:27`, and from the decoded token at
  line 69); the API-key strategy sets `collection: collectionConfig.slug`
  (`payload/dist/auth/strategies/apiKey.js:39`).
- For HTTP requests, `createPayloadRequest` runs `executeAuthStrategies` and
  assigns the result: `req.user = user`
  (`payload/dist/utilities/createPayloadRequest.js:86`); when no strategy
  matches, the result is `{ user: null }`
  (`payload/dist/auth/executeAuthStrategies.js:5`).
- Attribution filter: compare `req.user.collection ===
  req.payload.config.admin.user`. `config.admin.user` holds the slug of the
  admin auth collection, and Payload itself falls back to it (see section 4).
  Any user authenticated from a different auth collection (or an API key)
  still has a truthful `collection` slug, so the plugin can decline to
  attribute those and store `null`.

## 2. `beforeChange` for globals vs collections; field hooks on global fields

Document-level hooks differ:

- Collection `BeforeChangeHook` receives `{ collection, context, data,
  operation: 'create' | 'update', originalDoc?, req }`
  (`payload/dist/collections/config/types.d.ts:85-101`).
- Global `BeforeChangeHook` receives `{ context, data, global, originalDoc?,
  overrideAccess?, req }` — no `operation` argument
  (`payload/dist/globals/config/types.d.ts:55-66`).

Field-level hooks are shared and identical for both:

- One `FieldHook`/`FieldHookArgs` type serves collections and globals, with
  `collection: null | SanitizedCollectionConfig` ("If the field belongs to a
  global, this will be null") and `global: null | SanitizedGlobalConfig`
  (`payload/dist/fields/config/types.d.ts:18-85`). Args include `data`,
  `siblingData`, `originalDoc`, `previousValue`, `operation`, `req`.
- The global `update` operation imports and runs the exact same field
  traversals as collections — `beforeValidate` then `beforeChange` from
  `payload/dist/fields/hooks/...` — passing `collection: null`, `global:
  globalConfig`, `operation: 'update'`
  (`payload/dist/globals/operations/update.js:4-5,99-162`). Globals only ever
  run `operation: 'update'`; there is no create path.
- Inside the traversal, every field's `hooks.beforeChange` runs and a
  non-`undefined` return value is written into `siblingData[field.name]`
  (`payload/dist/fields/hooks/beforeChange/promise.js:58-85`).

So a field-level `beforeChange` hook works identically on global fields; the
hook just cannot rely on `args.collection` and should treat `operation` as
`'update'` for globals.

## 3. Drafts and autosave

- Admin autosave and draft saves go through the ordinary update operations:
  the collection `updateByID` operation accepts `autosave` and `draft` args
  (`payload/dist/collections/operations/updateByID.js:34`) and delegates to
  the shared `updateDocument` utility, which runs collection `beforeChange`
  hooks, then the field `beforeChange` traversal, then `saveVersion`
  (`payload/dist/collections/operations/utilities/update.js:123-162,268`).
  Same shape for globals (`payload/dist/globals/operations/update.js:127-266`).
- `saveVersion` receives `docWithLocales: result` — the document *after* the
  field hooks ran — so the version-table row copies the hooked
  `lastModifiedBy` value; version writes do not re-run or bypass field hooks
  (`payload/dist/globals/operations/update.js:253-264`, and the collection
  equivalent at `payload/dist/collections/operations/utilities/update.js:268`).
- `req.user` on autosave writes is whatever the HTTP request carries — admin
  autosave is an authenticated REST call, so the same auth-strategy population
  applies (section 1). There is no separate unauthenticated autosave path.
- One version-related subtlety: when a version is being restored, the
  beforeValidate fallback logic checks `req.context?.isRestoringVersion` and
  skips re-computing missing values
  (`payload/dist/fields/hooks/beforeValidate/promise.js:230`). A restore
  replays old data through the update operation, so the field hook still runs
  and will re-attribute the restore to the restoring user — which is the
  correct "last modified by" semantics.

## 4. Local API and jobs

- `createLocalReq` sets `req.user = user || req?.user || null`
  (`payload/dist/utilities/createLocalReq.js:91`). Calling
  `payload.update(...)` without `user` therefore yields `req.user === null`,
  and the hook must write `null`.
- When a caller passes `user` without a `collection` property, Payload
  silently fills it in from the admin auth collection: `req.user = { ...req.user,
  collection: payload.config.admin.user }`
  (`payload/dist/utilities/createLocalReq.js:92-99`, with a TODO to throw in
  4.0). So a Local API caller passing a bare user object still produces a
  `collection` that matches the plugin's attribution filter.
- `overrideAccess` defaults to `true` in Local API operations
  (`payload/dist/collections/operations/local/update.js:7`). This matters for
  section 5: field access checks are skipped entirely under `overrideAccess`,
  so a Local API caller *can* inject a `lastModifiedBy` value into `data` —
  but the field `beforeChange` hook runs after access filtering and its return
  value overwrites whatever survived, so the hook remains authoritative as
  long as it always returns a value (never `undefined`).
- Jobs: the queue runner threads through whatever `req` it was given
  (`payload/dist/queues/operations/runJobs/index.js:12`); jobs triggered by
  cron/autorun build their req via `createLocalReq` without a user, so task
  handlers doing writes see `req.user = null` unless the code enqueuing or
  running the job passes one. Attribution correctly becomes `null` there.

## 5. Denying caller writes while the hook still sets the field

Order of operations, verified in the shared field traversal:

1. `beforeValidate` field traversal runs first and executes field access
   control: for `create`/`update` it calls `field.access[operation]` (unless
   `overrideAccess`), and on a falsy result deletes the caller's value —
   `delete siblingData[field.name]` — then falls back to the existing document
   value (`payload/dist/fields/hooks/beforeValidate/promise.js:216-236`).
2. The `beforeChange` field traversal runs afterwards and applies the field
   hook's return value (`payload/dist/fields/hooks/beforeChange/promise.js:58-85`).

So `access: { create: () => false, update: () => false }` plus a field-level
`beforeChange` hook that returns the computed value is exactly the BlurHash
pattern (`packages/payload-blurhash/src/plugin.ts` — `denyCallerWrite`,
`createBlurHashField`), and it carries over to globals unchanged: the global
update operation calls the same `beforeValidate` traversal with the same
access filtering (`payload/dist/globals/operations/update.js:99-111`) before
the same `beforeChange` traversal. Two provisos:

- Under `overrideAccess: true` (the Local API default), access filtering is
  skipped, so the hook must return a definitive value on every invocation
  (user id or `null`), never `undefined`, to keep injected values from
  sticking.
- Globals have no `create` field-access operation in practice (writes are
  always `operation: 'update'`), but declaring both `create` and `update`
  denials is harmless and keeps one field definition for both targets.
