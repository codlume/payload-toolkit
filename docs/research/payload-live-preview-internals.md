# Payload Live Preview internals in 3.88 (handshake, message shape, block ids)

Resolves [#80](https://github.com/codlume/payload-toolkit/issues/80), part of the
Live Preview plugin map [#79](https://github.com/codlume/payload-toolkit/issues/79).

## Sources and how to read the citations

All admin-side citations are to the packages installed in this workspace at
`3.88.0`: `payload`, `@payloadcms/ui`, `@payloadcms/next`. Paths are relative to
`apps/payload-cms/node_modules/` and point at the compiled `dist/*.js` files, so
line numbers are those of the shipped JavaScript, not the TypeScript sources.

`@payloadcms/live-preview` and `@payloadcms/live-preview-react` are not installed;
their sources were read from the `payloadcms/payload` repository at tag `v3.88.0`
and are cited as GitHub links.

Docs consulted: [overview](https://payloadcms.com/docs/live-preview/overview),
[frontend](https://payloadcms.com/docs/live-preview/frontend),
[client](https://payloadcms.com/docs/live-preview/client),
[server](https://payloadcms.com/docs/live-preview/server). The docs describe the
user-facing API only; every mechanism claim below comes from source.

## Summary

Payload's Live Preview is a one-directional `window.postMessage` stream from the
admin Edit view into an iframe (or popup). The frontend announces itself with a
single `ready` message; from then on the admin posts the whole reduced form data on
every form-state change, with no throttling. Both ends gate on a `type` string and
on the sender's origin, so a second channel with its own `type` values can share
the same `window` without either side reacting to the other's messages. Block rows
carry a stable, client-generated `id` (bson ObjectId hex) from the moment they are
created, at every nesting depth, and that `id` survives into the frontend data.

## Verified facts

### 1. Iframe lifecycle and the `ready` handshake

**Where the pieces live.** `LivePreviewProvider` is mounted by the Document view
in `@payloadcms/next` around the whole edit form
(`@payloadcms/next/dist/views/Document/index.js:347-354`), receiving
`url: livePreviewURL` (the resolved `admin.livePreview.url`) and
`isLivePreviewing` (from the user's `editViewType` preference, or
`openByDefault`). The Edit view renders `LivePreviewWindow` next to the form when
`isLivePreviewEnabled && !isInDrawer && livePreviewURL`
(`@payloadcms/ui/dist/views/Edit/index.js:613-617`).

**How the URL is resolved.** `handleLivePreview` merges the root
`admin.livePreview` with the collection's or global's `admin.livePreview`, and
runs a `url` function on every render of the document view
(`@payloadcms/ui/dist/utilities/handleLivePreview.js:39-95`). Enablement is
"root `collections`/`globals` list OR entity-level `admin.livePreview`"
(`handleLivePreview.js:17-28`). A `url` function is re-run after every save
and the result pushed through `setURL` (`views/Edit/index.js:328-330`), which
resets `appIsReady` if the URL actually changed
(`@payloadcms/ui/dist/providers/LivePreview/index.js:84-96`).

**Iframe mounting.** The iframe is mounted once and never unmounted; toggling
Live Preview off only hides it (`providers/LivePreview/index.js:26-35`,
`shouldRenderIframe`). The `<iframe>` has `id="live-preview-iframe"`, `src={url}`
and an `onLoad` that records `loadedURL`
(`@payloadcms/ui/dist/elements/LivePreview/Window/index.js:107-118`).

**Ready detection (admin side).** The provider registers exactly one `message`
listener (`providers/LivePreview/index.js:152-165`):

```js
if (url?.startsWith(event.origin) && event.data && typeof event.data === 'object'
    && event.data.type === 'payload-live-preview') {
  if (event.data.ready) setAppIsReady(true)
}
```

So the admin accepts `ready` from any window whose origin is a prefix of the
preview URL; it does not check `event.source`. `appIsReady` is reset to `false`
when the URL changes (`index.js:93`) or when the window type switches between
iframe and popup (`index.js:166-172`). The `onLoad` of the iframe is not used
for readiness, only for `loadedURL`.

**Ready message (frontend side).** `ready({ serverURL })` posts
`{ type: 'payload-live-preview', ready: true }` to `window.opener || window.parent`
with `targetOrigin = serverURL`
([ready.ts:8-16](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/ready.ts#L8-L16)).
`useLivePreview` sends it once per mount via a ref guard
([useLivePreview.ts:83-89](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview-react/src/useLivePreview.ts#L83-L89));
`RefreshRouteOnSave` does the same and then calls `refresh()`
([RefreshRouteOnSave.tsx:36-45](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview-react/src/RefreshRouteOnSave.tsx#L36-L45)).

### 2. What the admin posts, and when

**Live preview message.** `LivePreviewWindow` has one effect that runs whenever
any of its deps change, guarded by `isLivePreviewing && appIsReady`
(`elements/LivePreview/Window/index.js:46-73`). It builds:

```js
const values = reduceFieldsToValues(formState, true)
if (!values.id) values.id = id
const message = {
  type: 'payload-live-preview',
  collectionSlug,
  data: values,
  externallyUpdatedRelationship: mostRecentUpdate,
  globalSlug,
  locale: locale.code,
}
iframeRef.current.contentWindow?.postMessage(message, url)     // iframe
popupRef.current.postMessage(message, url)                     // popup
```

The `targetOrigin` argument is `url`, the full preview URL (path included); the
browser derives the origin from it. The type of the event on the receiving side
is `LivePreviewMessageEvent<T>`
([types.ts:19-26](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/types.ts#L19-L26)):
`{ collectionSlug?, data: T, externallyUpdatedRelationship?: DocumentEvent, globalSlug?, locale?, type: 'payload-live-preview' }`.
`DocumentEvent` is `{ doc?, drawerSlug?, entitySlug, id?, operation: 'create' | 'update', updatedAt }`
(`payload/dist/admin/types.d.ts:205-211`).

**Frequency and throttling.** There is no debounce or throttle on the
`postMessage`. The effect's deps are `[formState, url, collectionSlug, globalSlug,
id, previewWindowType, popupRef, appIsReady, iframeRef, mostRecentUpdate, locale,
isLivePreviewing, loadedURL]` (`Window/index.js:73`). `formState` is the raw
reducer state exposed through `useAllFormFields`
(`@payloadcms/ui/dist/forms/Form/index.js:728-730`,
`forms/Form/context.js:52-54`), which changes on every dispatch, so every
keystroke posts a message. Separately, the form's server round-trip (`onChange`
to the form-state endpoint) is debounced at 250 ms
(`forms/Form/index.js:684-690`) and merges the server response back via
`MERGE_SERVER_STATE` (`index.js:676-680`), which produces another `formState`
and another message. The client docs' phrase "debounced form state" refers to
this server round-trip, not to the postMessage. The first message is also sent
the moment `appIsReady` flips to `true`, because it is a dep.

**Document event.** A second effect posts `{ type: 'payload-document-event' }`
with no payload whenever `mostRecentUpdate` changes (`Window/index.js:79-94`),
same targets and same `targetOrigin`. `mostRecentUpdate` comes from
`DocumentEventsProvider` (`@payloadcms/ui/dist/providers/DocumentEvents/index.js:10-40`)
and is set by `reportUpdate` after a successful save, autosave or publish
(`views/Edit/index.js:334-352`) and from bulk-upload drawers
(`elements/BulkUpload/EditForm/index.js:63`).

**Popup mode.** Same messages, posted to `popupRef.current`. `usePopupWindow`
opens the window with `eventType: 'payload-live-preview'`
(`providers/LivePreview/index.js:48-51`, `@payloadcms/ui/dist/hooks/usePopupWindow.js:6-12`).
Its own message listener is only active when an `onMessage` callback is given,
which Live Preview does not pass (`usePopupWindow.js:26-35`).

### 3. What the frontend exposes and how it validates origin

`@payloadcms/live-preview` exports `handleMessage`, `isDocumentEvent`,
`isLivePreviewEvent`, `mergeData`, `ready`, `subscribe`, `unsubscribe` and the
types `CollectionPopulationRequestHandler`, `LivePreviewMessageEvent`
([index.ts](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/index.ts)).

**Origin validation** is a strict equality on `serverURL`
([isLivePreviewEvent.ts](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/isLivePreviewEvent.ts),
[isDocumentEvent.ts](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/isDocumentEvent.ts)):

```ts
event.origin === serverURL && event.data && typeof event.data === 'object'
  && event.data.type === 'payload-live-preview'   // or 'payload-document-event'
```

Consequently `serverURL` must be exactly the admin origin (scheme, host, port; no
trailing slash or path) or nothing is ever accepted.

**`subscribe`** adds a `message` listener on `window` and returns the handler,
which `unsubscribe` removes
([subscribe.ts:19-36](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/subscribe.ts#L19-L36),
[unsubscribe.ts](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/unsubscribe.ts)).
The handler calls `handleMessage` and then `callback(mergedData)` for every
`message` event on the window, whatever its origin or type. For non-matching
events `handleMessage` returns the cached `previousData` (or `initialData`)
unchanged ([handleMessage.ts:59-63](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/handleMessage.ts#L59-L63)),
so `useLivePreview`'s `setData` receives the same object reference and React
bails out; foreign messages are harmless but do reach the callback.

**`useLivePreview({ serverURL, initialData, depth?, apiRoute?, requestHandler? })`**
returns `{ data, isLoading }`; `isLoading` starts `true` and becomes `false` on the
first merged message
([useLivePreview.ts:41-100](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview-react/src/useLivePreview.ts#L41-L100)).
The effect re-subscribes when any of `serverURL, depth, initialData, apiRoute,
requestHandler` change, and `subscribe` calls `resetCache()` on each subscription
([subscribe.ts:17](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/subscribe.ts#L17)).

**`RefreshRouteOnSave({ refresh, serverURL, apiRoute?, depth? })`** listens only
for `payload-document-event` and calls `refresh()`
([RefreshRouteOnSave.tsx:17-29](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview-react/src/RefreshRouteOnSave.tsx#L17-L29)).
It ignores `payload-live-preview` messages entirely, so a server-side preview
page never sees the streamed form data; it only re-renders after a save.

### 4. Block row `id`: present before save, at every depth

**Server-built form state.** When Payload builds form state from document data,
every blocks row is given `row.id = row?.id || new ObjectId().toHexString()`
(`@payloadcms/ui/dist/forms/fieldSchemasToFormState/addFieldStatePromise.js:305`;
arrays: `:175`). It then writes three flat state keys per row:
`${rowPath}.id`, `${rowPath}.blockType`, `${rowPath}.blockName`
(`addFieldStatePromise.js:308-347`), and keeps `{ id, blockType, collapsed? }`
per row in `fieldState.rows` (`:388-405`, `:424`). The blocks field itself gets
`value = rows.length` and `disableFormData = true` when it has rows
(`:418-422`). Because `iterateFields` recurses into `block.fields` with
`parentPath: rowPath` (`addFieldStatePromise.js:352-385`,
`iterateFields.js:83`), a nested blocks field inside a block goes through the
same `case 'blocks'` and its rows get ids too, under paths like
`layout.0.columns.1.id`.

**Client-created rows.** Adding a block dispatches `ADD_ROW` locally with no
server request (`forms/Form/index.js:527-545`; the Blocks field calls it at
`fields/Blocks/index.js:169-179`). The reducer creates
`id: subFieldState?.id?.value || new ObjectId().toHexString()` and writes
`${path}.${rowIndex}.id` immediately (`forms/Form/fieldReducer.js:24-27`,
`:48-53`). `DUPLICATE_ROW` mints a new id for the copy and for every nested
`*.id` key inside it (`fieldReducer.js:141-179`); `REPLACE_ROW` mints a new id
(`:295`). When the debounced server round-trip returns, `row?.id ||` keeps the
client id (`addFieldStatePromise.js:305`), so the id is stable from creation
through save. The id is a 24-hex-char bson ObjectId regardless of database
adapter (`bson-objectid` is imported directly by both files).

**Identity caveat.** `id` identifies a row; `path` (`layout.0.columns.1`) is
positional and changes on move, insert or delete. The admin DOM uses positional
ids for scrolling: `${path}-row-${rowIndex}` (`fields/Blocks/index.js:177`).

### 5. Streamed data is reduced form values, then server-populated; not form state

**Admin side.** `reduceFieldsToValues(formState, true)` keeps only `value` of
each field, skips fields with `disableFormData` (the blocks/array/group parents),
and unflattens dotted keys; numeric segments become arrays
(`payload/dist/utilities/reduceFieldsToValues.js:8-22`,
`payload/dist/utilities/unflatten.js:29-32,49-50`). The `data` field of the
message is therefore a plain document-shaped object with block rows rebuilt as
`{ id, blockType, blockName, ...fields }` from their flat sub-keys. It carries no
`valid`, `rows`, `errorPaths` or schema information. Relationship values are
whatever the form stores (ids, or `{ relationTo, value }`), unpopulated. Locale
values are already flattened to the active locale
([mergeData.ts:51-52](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/mergeData.ts#L51-L52)).
Quirk: a blocks field with zero rows has `disableFormData` unset and
`value = 0`, so it arrives as `0` rather than `[]` (`addFieldStatePromise.js:418-422`).

**Frontend side.** `handleMessage` does not merge in JavaScript. `mergeData`
POSTs to `${serverURL}${apiRoute ?? '/api'}/{collection}/{initialData.id}` (or
`/globals/{slug}`) with `X-Payload-HTTP-Method-Override: GET`,
`credentials: 'include'` and body `{ data: incomingData, depth, flattenLocales: false, locale }`,
then returns the JSON as the new `data`
([mergeData.ts:3-20,44-61](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/mergeData.ts#L3-L61)).
On the server, `handleEndpoints` parses the JSON body into `req.data` for
override-GET requests (`payload/dist/utilities/handleEndpoints.js:58-70`), the
`findByID` handler merges `req.data` into its params
(`payload/dist/collections/endpoints/findByID.js:7-12`), and the operation uses
`args.data ?? docFromDB` as the document to run the read pipeline over
(`payload/dist/collections/operations/findByID.js:106-112`; globals:
`payload/dist/globals/operations/findOne.js:76`). So `depth` population is
performed by Payload's normal `afterRead` traversal on the posted form data, and
the frontend `data` is a fully shaped document with relationships populated to
`depth`, block `id`s intact, and one HTTP request per received message. The
client docs add: "It is important that the `depth` argument matches exactly with
the depth of your initial page request."

`initialData` is only used for `initialData.id` in the endpoint path and as the
fallback returned for non-matching events
([handleMessage.ts:38-40,59-63](https://github.com/payloadcms/payload/blob/v3.88.0/packages/live-preview/src/handleMessage.ts#L38-L63));
messages without `collectionSlug` or `globalSlug` return `initialData` unchanged.

**Effect on locating a block by id.** On the frontend the block's `id` is in
`data` exactly where the admin placed it. Nothing in the message says which
fields are blocks; a consumer locates rows by walking `data` for objects with
`blockType`, or by the developer marking the rendering component with the row
`id` it received. On the admin the reverse lookup is a scan of `formState` keys
ending in `.id` whose `value` equals the target, which yields the positional
`path` needed for the DOM and for `rows` metadata (collapsed state).

### 6. Hooks that let a second channel coexist

- **Type gating on both ends.** The admin reacts only to
  `event.data.type === 'payload-live-preview'` with `ready: true`
  (`providers/LivePreview/index.js:154-157`); the frontend helpers react only
  to `'payload-live-preview'` / `'payload-document-event'`. Messages with any
  other `type` are ignored by Payload's admin and pass through `subscribe`'s
  handler as a no-op. A bridge that uses its own `type` namespace does not
  interfere and is not interfered with. Payload's `type` strings are not
  configurable.
- **Origin discipline to mirror.** Admin to frontend: `postMessage(msg, url)`
  where `url` is the preview URL; frontend to admin: `postMessage(msg, serverURL)`
  to `window.opener || window.parent`. Admin validates `url.startsWith(event.origin)`;
  frontend validates `event.origin === serverURL`. A bridge can reuse both values.
- **Admin-side access points.** `@payloadcms/ui` publicly exports
  `useLivePreviewContext` (gives `appIsReady`, `iframeRef`, `popupRef`,
  `previewWindowType`, `url`, `isLivePreviewing`, `setAppIsReady`;
  `providers/LivePreview/index.js:191-227`, `providers/LivePreview/context.js:47`),
  `useAllFormFields` (raw form state), `useDocumentEvents`, and
  `LivePreviewWindow` itself (`@payloadcms/ui/dist/exports/client/index.d.ts`).
  Any client component rendered inside the Edit view (for example via
  `admin.components.edit.*` or `afterDocument` slots) can read these.
- **Replacing the window.** `admin.components.views.edit.livePreview.Component`
  is rendered in place of `LivePreviewWindow`
  (`@payloadcms/next/dist/views/Document/renderDocumentSlots.js:50-57`,
  `views/Edit/index.js:613-617`, `DocumentSlots.LivePreview` in
  `payload/dist/admin/types.d.ts:140-153`). It is a replace slot, not a wrapper,
  so a plugin using it would have to render `LivePreviewWindow` itself and
  would collide with any user customization of the same slot.
- **`ready` is the only inbound message the admin understands.** A bridge cannot
  piggy-back extra fields on `ready` to signal its own presence, because the
  admin only reads `event.data.ready`; it needs its own handshake message.
- **`serverURL` has no admin-side equivalent to check.** The frontend's
  `serverURL` is a prop the developer passes; the admin never receives it. A
  bridge that wants the frontend to learn the admin origin without
  configuration can take it from `event.origin` of the first accepted
  Payload message, or require `serverURL` like Payload does.

## Open questions and caveats

- The ObjectId row `id` survival across a save into the database and back was
  checked in the form-state builder (`row?.id ||`), not in each database adapter;
  Payload persists block `id`s as part of the document, so this is expected but
  not traced through `@payloadcms/db-*`.
- `useLivePreview` re-subscribes when `initialData` changes identity; a page
  that re-creates `initialData` on every render will churn subscriptions and
  reset the merge cache (`resetCache()` on subscribe). Not a bridge concern but
  affects timing of the first `payload-live-preview` after a navigation.
- Whether the message effect fires for every keystroke in practice depends on
  `FormFieldsContext` publishing every reducer update; this is what the code
  does (`Form/index.js:728-730`), but no profiling was done.
