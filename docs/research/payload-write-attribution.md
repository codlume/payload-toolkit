# Reading the acting user on every write in Payload 3.88 (`lastModifiedBy`)

## Answer

A field-level `beforeChange` hook is the single reliable seam. Every persisted
write to a collection or global — create, update, publish, draft save, autosave,
and version restore — funnels through the shared `beforeChange` field traversal
(`payload/dist/fields/hooks/beforeChange/index.js` L15-L24, which selects
`collection?.fields || global?.fields`), and every one of those code paths
receives the same `req`. The hook should read `req.user`, attribute only when
`req.user.collection === payload.config.admin.user`, and always return either
the user reference or `null` — never `undefined` — because with the Local API's
default `overrideAccess: true` the access-control stripping is skipped and only
an unconditional hook return value guarantees the caller cannot inject the
field. `req.user` is `null` for unauthenticated REST calls, for Local API calls
that do not pass `user`/`req`, and for `payload.jobs.run()` with a fresh req, so
the hook must map "no user" to `lastModifiedBy: null`. The repo's BlurHash
pattern (field `access.create/update: () => false` plus a field `beforeChange`
hook) carries over to globals unchanged, with one non-breaking nuance: globals
only ever evaluate the `update` access function, since global writes always run
as `operation: 'update'`.

All citations below use the package-relative path `payload/dist/...` for the
Payload 3.88.0 sources on disk at
`node_modules/.pnpm/payload@3.88.0_graphql@16.14.2_typescript@5.9.3/node_modules/payload`.

## 1. `req.user` shape and where it is set

- `PayloadRequest` declares `user: null | TypedUser` under the comment
  "The signed-in user" (`payload/dist/types/index.d.ts` L69-L70; the interface
  itself at L97). `TypedUser` resolves to the project's generated user union
  (`payload/dist/index.d.ts` L217-L222).
- The server-side user always carries the slug of the auth collection it came
  from: `BaseUser = { collection: string; email?; id; sessions?; username? }`
  (`payload/dist/auth/types.d.ts` L92-L98). A type comment states `collection`
  "is not available on the client. It's only available on the server
  (req.user)" (`payload/dist/auth/types.d.ts` L104-L111). Auth strategies return
  `user: ({ _strategy?; collection? } & TypedUser) | null`
  (`payload/dist/auth/types.d.ts` L150-L156).
- On HTTP requests, `createPayloadRequest` builds the req with `user: null`,
  runs `executeAuthStrategies`, then assigns `req.user = user`
  (`payload/dist/utilities/createPayloadRequest.js` L76-L86). Strategies run in
  order and the first one returning a user wins
  (`payload/dist/auth/executeAuthStrategies.js`).
- The built-in JWT strategy sets `user.collection` from the token's own
  `collection` claim after re-fetching the user
  (`payload/dist/auth/strategies/jwt.js` L66-L82, assignment at L82), and the
  autoLogin path sets it from `payload.config.admin.user`
  (`payload/dist/auth/strategies/jwt.js` L9 and L38). The API-key strategy sets
  `user.collection = collectionConfig.slug` per auth-enabled collection
  (`payload/dist/auth/strategies/apiKey.js` L47-L49).
- Consequence for the plugin: because JWT and API-key users can come from any
  auth-enabled collection, gating attribution on
  `req.user.collection === req.payload.config.admin.user` is the correct filter,
  and the slug comparison is exactly how Payload itself resolves the admin auth
  collection (`payload/dist/auth/strategies/jwt.js` L9;
  `payload/dist/utilities/createLocalReq.js` L94-L99).

## 2. Hook signatures: collections vs globals, and field hooks

- Collection `BeforeChangeHook` args: `{ collection, context, data, operation:
  CreateOrUpdateOperation, originalDoc? (undefined on create), req }`
  (`payload/dist/collections/config/types.d.ts` L85-L101).
- Global `BeforeChangeHook` args: `{ context, data, global, originalDoc?,
  overrideAccess?, req }` — there is **no `operation` argument** on the
  global document-level hook (`payload/dist/globals/config/types.d.ts` L55-L66),
  and the global update operation indeed does not pass one
  (`payload/dist/globals/operations/update.js` L129-L140). (`previousDoc` only
  exists on `afterChange`, in both variants:
  `payload/dist/collections/config/types.d.ts` L102-L110;
  `payload/dist/globals/config/types.d.ts` L67-L79.)
- Field hooks are a single shared type for both entities. `FieldHookArgs`
  includes `collection: null | SanitizedCollectionConfig` ("If the field
  belongs to a global, this will be null"), `global: null |
  SanitizedGlobalConfig`, `operation?: 'create' | 'delete' | 'read' | 'update'`,
  `originalDoc?`, `previousValue?`, `req`, `siblingData`, `value`
  (`payload/dist/fields/config/types.d.ts` L18-L84).
- Both collection and global operations call the same field traversal:
  `beforeChange` picks `fields: collection?.fields || global?.fields`
  (`payload/dist/fields/hooks/beforeChange/index.js` L15-L24), and the per-field
  promise invokes `field.hooks.beforeChange` with `collection`, `global`,
  `operation`, `originalDoc: doc`, `previousValue: siblingDoc[field.name]`,
  `req`, `value: siblingData[field.name]`, assigning any non-`undefined`
  return into `siblingData[field.name]`
  (`payload/dist/fields/hooks/beforeChange/promise.js` L58-L83).
- Args on a global write: the global update operation passes `collection: null,
  global: globalConfig, operation: 'update'` into both the `beforeValidate`
  and `beforeChange` field passes (`payload/dist/globals/operations/update.js`
  L101-L110 and L144-L156). Globals have no create operation — the first save
  still runs `updateOperation` and merely calls `db.createGlobal` when the row
  does not exist (`payload/dist/globals/operations/update.js` L233-L246) — so a
  field hook on a global always sees `operation: 'update'`. On collections the
  hook sees `operation: 'create'` (`payload/dist/collections/operations/create.js`
  L138-L149) or `'update'`
  (`payload/dist/collections/operations/utilities/update.js` L140-L158).
- Conclusion: one `FieldHook` implementation works identically for collections
  and globals; distinguish the host via the `collection` / `global` args if
  needed.

## 3. Drafts and autosave

- Admin autosave is an ordinary update request: the REST handlers parse
  `draft` and `autosave` from the query string and call the same operations
  with the authenticated `req`
  (`payload/dist/collections/endpoints/updateByID.js` L8-L24;
  `payload/dist/globals/endpoints/update.js` L12-L30). Since `req.user` was set
  by `createPayloadRequest` (section 1), every autosave carries the acting user.
- The `beforeChange` field pass runs unconditionally on every update, draft or
  not (`payload/dist/collections/operations/utilities/update.js` L140-L162;
  `payload/dist/globals/operations/update.js` L144-L156). Draft saves only skip
  the main-table write (`if (!isSavingDraft) { ...db.updateOne }` at
  `payload/dist/collections/operations/utilities/update.js` L253-L263; global
  equivalent at `payload/dist/globals/operations/update.js` L225-L247) and then
  persist through `saveVersion` with `docWithLocales: result`, i.e. the
  post-hook data (`payload/dist/collections/operations/utilities/update.js`
  L267-L281; `payload/dist/globals/operations/update.js` L251-L265).
- `saveVersion` does not re-run any hooks: it deep-copies `docWithLocales` into
  `versionData` and writes it (`payload/dist/versions/saveVersion.js` L8-L18).
  On autosave it updates the latest version row in place when that row is
  itself an autosave version, otherwise creates a new version — either way with
  the same already-hooked `versionData`
  (`payload/dist/versions/saveVersion.js` L20-L31;
  `payload/dist/versions/updateLatestVersion.js` L37-L49). So the version table
  always records the hook's value; there is no bypass path.
- `publishSpecificLocale`: the operation pins `req.locale` and merges the hooked
  result over the stored published doc via `mergeLocalizedData`
  (`payload/dist/globals/operations/update.js` L18-L20 and L189-L215;
  `payload/dist/collections/operations/utilities/update.js` L196-L231). For a
  **non-localized** field the merge takes the incoming (hooked) value whenever
  the key is present (`payload/dist/utilities/mergeLocalizedData.js` L213-L217),
  so keep `lastModifiedBy` non-localized and the attribution lands even on
  single-locale publishes; the draft snapshot saved alongside is also the
  post-hook result (`payload/dist/collections/operations/utilities/update.js`
  L220-L231 with `payload/dist/versions/saveVersion.js` L57-L69).
- Restoring a version replays the full pipeline: `restoreVersionOperation` runs
  the `beforeValidate` and `beforeChange` field passes with
  `operation: 'update'` and sets `req.context.isRestoringVersion = true`
  (`payload/dist/collections/operations/restoreVersion.js` L127-L194). The field
  hook therefore runs on restore too — the restored document is attributed to
  the restorer, not to whoever wrote the restored version. The
  `isRestoringVersion` flag only suppresses default-value backfill in
  `beforeValidate` (`payload/dist/fields/hooks/beforeValidate/promise.js`
  L180 and L230); it does not skip field hooks.
- One asymmetry: the globals Local API update wrapper accepts no `autosave`
  option (`payload/dist/globals/operations/local/update.js` L6-L26), so global
  autosave only arrives via REST — which is the authenticated admin path anyway.

## 4. Local API and jobs: `req.user` is null unless supplied

- `createLocalReq` sets `req.user = user || req?.user || null`
  (`payload/dist/utilities/createLocalReq.js` L91). A bare
  `payload.update({...})` therefore runs with `req.user === null`. When a caller
  does pass `user`, Payload backfills a missing `collection` with
  `payload.config.admin.user` (`payload/dist/utilities/createLocalReq.js`
  L94-L99) — so Local-API-supplied users without an explicit collection are
  treated as admin-collection users.
- Local operation wrappers default `overrideAccess = true`
  (`payload/dist/collections/operations/local/update.js` L7;
  `payload/dist/globals/operations/local/update.js` L6). `overrideAccess` skips
  access functions — including the field-level access stripping in section 5 —
  but never skips hooks.
- Jobs: `payload.jobs.run()` / `runByID()` use `args.req ?? await
  createLocalReq({}, payload)` (`payload/dist/queues/localAPI.js` L176-L198), so
  task handlers and any writes they perform run with `req.user === null` unless
  the caller threaded through an authenticated `req` (e.g. the autorun/REST
  trigger's request).
- Conclusion: the hook must treat `req.user` as `null | TypedUser` and return
  `null` for system writes rather than leaving the previous value, if the
  desired semantic is "last write was not attributable".

## 5. Denying caller writes while the hook still sets the value

- Field access filtering runs in the **`beforeValidate` field pass**, which
  precedes the document-level `beforeChange` hooks and the `beforeChange` field
  pass in both operations (order visible in
  `payload/dist/collections/operations/utilities/update.js` L88-L162 and
  `payload/dist/globals/operations/update.js` L98-L156). Inside that pass,
  after the field's own `beforeValidate` hooks, Payload evaluates
  `field.access[operation]` and on a falsy result deletes the caller's value:
  `delete siblingData[field.name]`
  (`payload/dist/fields/hooks/beforeValidate/promise.js` L216-L229). The slot is
  then refilled from the existing document value or the field default
  (`payload/dist/fields/hooks/beforeValidate/promise.js` L230-L236;
  `payload/dist/fields/hooks/beforeValidate/getFallbackValue.js` L3-L17).
- The field-level `beforeChange` hook runs later, in the separate
  `beforeChange` traversal, and any non-`undefined` return value overwrites
  `siblingData[field.name]` (`payload/dist/fields/hooks/beforeChange/promise.js`
  L58-L83). So: access stripping happens strictly before the field
  `beforeChange` hook, and the hook's return value is what gets stored — the
  exact behavior the BlurHash plugin relies on
  (`packages/payload-blurhash/src/plugin.ts` L333, L412-L436: `access: {
  create: denyCallerWrite, update: denyCallerWrite }` plus
  `hooks: { beforeChange: [lifecycleHook] }`).
- This carries over to globals unchanged, because the global update operation
  runs the same `beforeValidate` pass (access check included) and the same
  `beforeChange` pass with the global's fields
  (`payload/dist/globals/operations/update.js` L101-L110 and L144-L156;
  `payload/dist/fields/hooks/beforeChange/index.js` L24). Two nuances, neither
  breaking:
  1. Globals always run with `operation: 'update'` (section 2), so only
     `access.update` is ever evaluated on a global; the `create` function is
     dead code there but harmless to keep for config symmetry.
  2. When `overrideAccess` is true (the Local API default, section 4), the
     access check is short-circuited (`const result = overrideAccess ? true :
     await field.access[operation](...)`,
     `payload/dist/fields/hooks/beforeValidate/promise.js` L217-L225) and the
     caller's value is **not** stripped. The field `beforeChange` hook still
     runs afterward, so the value is only protected if the hook always returns
     something. A `lastModifiedBy` hook must therefore return the attribution
     (ID or `null`) on every invocation — mirroring how the BlurHash hook
     returns a value on every branch — rather than returning `undefined` to
     "leave the value alone".
