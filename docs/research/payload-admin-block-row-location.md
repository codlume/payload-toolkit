# Payload Admin extension points for locating a block row (Payload 3.88.0)

Resolves codlume/payload-toolkit#81 (part of the Live Preview plugin map, #79).

Question: from inside Payload Admin 3.88, how can a plugin scroll to, expand and
highlight a specific block row (at any nesting depth) by its row id, and detect
when the editor is working inside a block row?

All citations are to the packages installed in this workspace. Path prefixes:

- `ui/` = `apps/payload-cms/node_modules/@payloadcms/ui/dist/`
- `next/` = `apps/payload-cms/node_modules/@payloadcms/next/dist/`
- `payload/` = `apps/payload-cms/node_modules/payload/dist/`

Versions: `payload`, `@payloadcms/ui`, `@payloadcms/next` all `3.88.0`
(`ui/../package.json`, `payload/../package.json`).

## Recommendation

Mount the admin side of the plugin in `admin.components.views.edit.livePreview.Component`
and render Payload's exported `LivePreviewWindow` from it. That slot is the only
config-addressable component that renders inside the document `Form`, inside
`DocumentInfoProvider` and inside `LivePreviewProvider`, and only when Live Preview
is enabled for the document. From there:

- Locate a row by id through form state, not the DOM: the row id lives in
  `fields[blocksPath].rows[i].id` and `fields["<blocksPath>.<i>.id"].value`; no DOM
  attribute carries it.
- Expand every collapsed ancestor by dispatching `SET_ROW_COLLAPSED` per ancestor
  blocks field and persisting with `setDocFieldPreferences(path, { collapsed })`,
  exactly as the Blocks field does internally.
- Scroll to the row wrapper `div#<parentPath-with-dashes>-row-<index>`, waiting for
  nested content to mount because collapsed content is `display: none` and nested
  fields render lazily via `RenderIfInViewport`.
- Detect focus with a `focusin` (and `click`) listener on `useForm().formRef`, walk
  up to the nearest `.blocks-field__row`, read the index from the wrapper id and the
  path from the enclosing `.blocks-field#field-<path with __>`, then map to the row
  id in form state.
- Reach the iframe through `useLivePreviewContext().iframeRef` and post with
  `iframeRef.current.contentWindow.postMessage(msg, url)`.
- Ship the component from a `./client` subpath and reference it as
  `"@codlume/payload-live-preview/client#<ExportName>"`; `generate:importmap`
  traverses `views.edit.*.Component` automatically.

Everything else below is the evidence.

## 1. Custom component slots that render inside the Live Preview edit view

The document view is assembled server-side in `next/views/Document/index.js`.
`DocumentInfoProvider` wraps `LivePreviewProvider`, which wraps the rendered view
(`next/views/Document/index.js:320-380`, provider nesting at 347-354 and 370-378).
The default edit view is `DefaultEditView` from `@payloadcms/ui`
(`next/views/Edit/index.js:4-10`). Inside it, everything below the `<main>` is
wrapped in `<Form isDocumentForm>` (`ui/views/Edit/index.js:452-462`).

| Slot | Config key | Renders where | `useForm` | `useLivePreviewContext` | Notes |
| --- | --- | --- | --- | --- | --- |
| Live Preview window override | `admin.components.views.edit.livePreview.Component` (collection or global) | Replaces `LivePreviewWindow` inside `.collection-edit__main-wrapper`, inside the document Form | yes | yes | Rendered only when `isLivePreviewEnabled && !isInDrawer && livePreviewURL` |
| Before document controls | `admin.components.edit.beforeDocumentControls` (collections), `admin.components.elements.beforeDocumentControls` (globals) | In `DocumentControls`, next to the Live Preview toggler, inside the Form | yes | yes | Always rendered, even when Live Preview is off |
| Root providers | `admin.components.providers` | Root layout, above every route | no | no | Outside `DocumentInfoProvider`, `LivePreviewProvider` and `Form` |
| Blocks field override | `admin.components.Field` on a `blocks` field | Replaces `BlocksField` for that field | yes | yes | Per-field; can wrap the exported `BlocksField` |
| Block row label | `admin.components.Label` on a block | Inside each row's collapsible header | yes | yes | Server-rendered per row; a client component inside gets `useRowLabel()` |
| Block override | `admin.components.Block` on a block | Not read by the classic Blocks field | - | - | Lexical only |
| `AfterFields` / `BeforeFields` | none | `DocumentInfoProvider` props, set only by the Account and BulkUpload views | - | - | Not a config slot |

Evidence:

- `views.edit.livePreview.Component` is resolved in
  `next/views/Document/renderDocumentSlots.js:50-57` into `components.LivePreview`
  and passed to the view as client props (`next/views/Document/index.js:290-294`,
  `DocumentSlots.LivePreview` in `payload/admin/types.d.ts:140-144`). The edit
  view reads it as `CustomLivePreview` (`ui/views/Edit/index.js:48`) and renders
  `CustomLivePreview || <LivePreviewWindow/>` at
  `ui/views/Edit/index.js:613-617`, after `DocumentFields`, inside the Form
  (`452-462`). The type is `DefaultDocumentViewConfig` under `EditConfigWithoutRoot`
  (`payload/config/types.d.ts:1403-1411`). The import map picks it up through
  `payload/bin/generateImportMap/iterateCollections.js:30-34`. `LivePreviewWindow`
  is a public export (`ui/exports/client/index.d.ts:322`), so the override can
  render it unchanged and add behavior around it.
- `beforeDocumentControls` is resolved at
  `next/views/Document/renderDocumentSlots.js:26-33`, passed to `DocumentControls`
  (`ui/views/Edit/index.js:527-529`) and rendered at
  `ui/elements/DocumentControls/index.js:222` immediately before
  `LivePreviewToggler`. The config type is `CustomComponent[]`
  (`payload/collections/config/types.d.ts:270-274`). Import map:
  `iterateCollections.js:18`. Docs list it as rendering "just before the default
  document action buttons"
  (https://payloadcms.com/docs/custom-components/edit-view).
- `admin.components.providers` is rendered by `NestProviders` in the root layout
  (`next/layouts/Root/index.js:126-136`), which is above the per-document
  providers created in `next/views/Document/index.js`. Type:
  `payload/config/types.d.ts:734-741`. Import map: `iterateConfig.js:52`.
- `admin.components.Field` replaces the field component
  (`ui/forms/fieldSchemasToFormState/renderField.js:181`, `FieldAdmin.components`
  in `payload/fields/config/types.d.ts:172-182`). `BlocksField` is exported
  (`ui/exports/client/index.d.ts:148`). Import map: `iterateFields.js:65`.
- Block `admin.components.Label` is server-rendered per row into
  `fieldState.rows[rowIndex].customComponents.RowLabel` with server props
  `blockType`, `rowLabel`, `rowNumber` (`renderField.js:125-140`; type
  `BlockRowLabelClientComponent` in `payload/admin/fields/Blocks.d.ts:19-25`).
  `BlockRow` renders it through `RowLabel` (`ui/fields/Blocks/BlockRow.js:142-159`,
  `Label` prop from `rows[i].customComponents.RowLabel` at
  `ui/fields/Blocks/index.js:415`), which wraps it in `RowLabelProvider` with
  `path = rowPath` and `rowNumber = rowIndex` (`ui/forms/RowLabel/index.js:16-19`).
  Rows are only re-rendered on the server when `lastRenderedPath` changes
  (`renderField.js:118-122`). Import map: `iterateFields.js:61`.
- Block `admin.components.Block` is documented as "replace the entire block
  component, including the block header / collapsible"
  (`payload/fields/config/types.d.ts:1140-1143`), but no file under
  `@payloadcms/ui/dist` reads `components.Block` (grep), and the Blocks field docs
  scope it to Lexical (https://payloadcms.com/docs/fields/blocks). Import map:
  `iterateFields.js:62`.
- `AfterFields` / `BeforeFields` are `DocumentInfoProps`
  (`ui/providers/DocumentInfo/types.d.ts:7,9`), read in
  `ui/views/Edit/index.js:61-64` and rendered by `DocumentFields`
  (`ui/elements/DocumentFields/index.js:48-57`). The only producers are
  `next/views/Account/index.js:123` and `ui/elements/BulkUpload/EditForm/index.js:118`.
  There is no `afterFields` config key; the docs edit-view page does not list one.

Form contexts available to any client component inside the Form
(`ui/forms/Form/index.js:691-740`): `DocumentFormContext` (because
`isDocumentForm: true`), `FormContext`, `FormWatchContext`, `FormFieldsContext`.
Public hooks: `useForm`, `useDocumentForm`, `useWatchForm`, `useFormFields`,
`useAllFormFields` (`ui/forms/Form/context.d.ts:22-49`,
`ui/exports/client/index.d.ts:183`). `useForm()` exposes `dispatchFields`,
`getFields`, `getField`, `getDataByPath`, `formRef`
(`ui/forms/Form/types.d.ts:211-270`).

## 2. How the Blocks field renders rows in the DOM

Field container (`ui/fields/Blocks/index.js:302-305`):

```
<div class="field-type blocks-field [className] blocks-field--has-no-error"
     id="field-<path with '.' replaced by '__'>">
```

Top level: `id="field-layout"`. Nested blocks field at path `layout.0.columns`:
`id="field-layout__0__columns"`. This id is unambiguous (`__` separator) and is the
best DOM anchor for recovering a field path.

Rows container (`ui/fields/Blocks/index.js:383-390`): `DraggableSortable` renders
`<div class="blocks-field__rows">` (`ui/elements/DraggableSortable/index.js:124-128`)
with `ids: rows.map(row => row.id)` as the dnd-kit sortable items.

Row wrapper (`ui/fields/Blocks/BlockRow.js:107-112`):

```
<div id="<parentPath.split('.').join('-')>-row-<rowIndex>" ref={setNodeRef} style={{ transform }}>
```

`parentPath` is the blocks field path (`ui/fields/Blocks/index.js:418`), so:

- top-level row 2 of `layout`: `id="layout-row-2"`
- nested row 1 of `layout.0.columns`: `id="layout-0-columns-row-1"`

The wrapper carries the index and the path (dot to dash), never the row id. The
dash form is ambiguous if a field name contains `-`; prefer the `field-...__...`
id on the enclosing `.blocks-field` for the path and use the wrapper only for the
`-row-<n>` suffix. The `setNodeRef` is dnd-kit's sortable node ref
(`ui/elements/DraggableSortable/useDraggableSortable/index.js:34-41`).

Inside the wrapper (`BlockRow.js:113-178` and `ui/elements/Collapsible/index.js:57-133`):

- `div.collapsible.blocks-field__row.blocks-field__row--no-errors|--has-errors`
  plus `collapsible--collapsed` when collapsed, `collapsible--nested` when inside
  another `Collapsible`, `collapsible--has-drag-handle`, `collapsible--style-default|error`
  (`Collapsible/index.js:57-64, 90-91`; `BlockRow.js:58-67, 130-131`).
- `div.collapsible__toggle-wrap` containing
  `button.collapsible__toggle.collapsible__toggle--collapsed|open` (`Collapsible/index.js:99-105`),
  `div.collapsible__drag` with dnd-kit attributes (`106-110`), which are
  `role`, `tabIndex`, `aria-disabled`, `aria-pressed`, `aria-roledescription`,
  `aria-describedby` (`node_modules/.pnpm/@dnd-kit+core@6.3.1_*/node_modules/@dnd-kit/core/dist/core.esm.js:3434-3438`)
  and no id or data attribute, and `div.collapsible__header-wrap` holding
  `div.blocks-field__block-header` > `span.blocks-field__block-number`,
  `Pill.blocks-field__block-pill.blocks-field__block-pill-<blockType>` and the
  `SectionTitle` (blockName input at `<rowPath>.blockName`) (`BlockRow.js:140-159`).
  The block type is therefore readable from the pill class; the row id is not.
- `AnimateHeight` content: `div.rah-static[aria-hidden]` > inner `div` >
  `div.collapsible__content` > `RenderFields` `div.render-fields.blocks-field__fields`
  (`Collapsible/index.js:126-131`, `BlockRow.js:168-177`,
  `ui/elements/AnimateHeight/index.js:60-78`, `ui/forms/RenderFields/index.js:106-110`).

Two rendering facts matter for locate:

1. Collapsed content is hidden with `display: none` on the inner div, applied
   300 ms after collapse and removed immediately on expand
   (`AnimateHeight/index.js:11, 27-43, 69-75`).
2. `RenderFields` wraps children in `RenderIfInViewport`, which renders `null` until
   the wrapper is within 1000 px of the viewport or above it, unless `forceRender`
   is set (`ui/forms/RenderFields/index.js:106-110`,
   `ui/elements/RenderIfInViewport/index.js:14-27, 46`). `DocumentFields` passes
   `forceRender: true` for top-level fields (`ui/elements/DocumentFields/index.js:48-57`);
   `BlockRow` does not (`BlockRow.js:168-177`). Nested blocks fields, and their
   rows, are not in the DOM until the parent row is expanded and near the viewport.
   A row whose `isLoading` is true renders a `ShimmerEffect` instead of fields
   (`BlockRow.js:137, 168`).

Row identity in form state (`payload/admin/forms/Form.d.ts:10-19`, `Row` has
`id`, `blockType`, `collapsed`, `isLoading`, `lastRenderedPath`):

- `fields[blocksPath].rows[i]` (`ui/forms/fieldSchemasToFormState/addFieldStatePromise.js:387-403`).
- `fields["<blocksPath>.<i>.id"] = { value: row.id }` (`addFieldStatePromise.js:304-311`);
  `fields["<blocksPath>.<i>.blockType"]` (`329-333`).
- The `id` field is `admin.hidden: true` (`payload/fields/baseFields/baseIDField.js:3-8`),
  and `RenderFields` skips hidden fields (`RenderFields/index.js:46`), so it never
  reaches the DOM.
- The blocks field's `value` is the row count, not the array
  (`addFieldStatePromise.js:417-418`); use `useForm().getDataByPath(path)` for data.

Field paths: `getFieldPaths` builds `path = parentPath + '.' + name`
(`payload/fields/getFieldPaths.js:6-10`); `BlockRow` renders nested fields with
`parentPath: rowPath` (`BlockRow.js:173`), so a nested blocks field `columns` in
row 0 of `layout` has path `layout.0.columns` and its rows `layout.0.columns.<i>`.

Arrays render the same wrapper id shape (`ui/fields/Array/ArrayRow.js:70, 84`) plus
a header id `<scrollIdPrefix>-row-<i>` (`ArrayRow.js:113`), so the v2 extension is
mechanical.

Payload's own scroll helper `scrollToID` does `document.getElementById` and
`window.scrollBy({ top: bounds.top - 100, behavior: 'smooth' })`
(`ui/utilities/scrollToID.js:1-10`); the window is the scroll container. The Blocks
field calls it with `${path}-row-${index}` using the dotted path
(`ui/fields/Blocks/index.js:176-178`), which only matches top-level fields; do not
copy that.

## 3. Expanding a collapsed row programmatically, including ancestors

Collapse is form state, not component state, for block rows:

- `Collapsible` takes `isCollapsed` as a controlled prop and falls back to local
  state only when the prop is not a boolean (`ui/elements/Collapsible/index.js:33, 41`).
  `BlockRow` passes `isCollapsed: row.collapsed` and
  `onToggle: collapsed => setCollapse(row.id, collapsed)` (`BlockRow.js:99-100, 166-167`).
- `setCollapse` (`ui/fields/Blocks/index.js:221-238`) runs
  `extractRowsAndCollapsedIDs({ collapsed, rowID, rows })`, which mutates the
  matching row's `collapsed` in place and collects the ids of all still-collapsed
  rows (`ui/forms/Form/rowHelpers.js:3-21`), then
  `dispatchFields({ type: 'SET_ROW_COLLAPSED', path, updatedRows })` and
  `setDocFieldPreferences(path, { collapsed: collapsedIDs })`.
- The reducer replaces `state[path].rows` with `updatedRows`
  (`ui/forms/Form/fieldReducer.js:373-386`; `SET_ALL_ROWS_COLLAPSED` at `359-372`).
  Action types: `ui/forms/Form/types.d.ts:199-208`.
- `setDocFieldPreferences` merges `{ fields: { [path]: { ...existing, ...fieldPreferences } } }`
  under the document preference key `collection-<slug>-<id>` or `global-<slug>`
  (`ui/providers/DocumentInfo/index.js:124-134, 231-249`). Shape:
  `InsideFieldsPreferences = { collapsed: string[]; tabIndex: number }`
  (`payload/preferences/types.d.ts:12-25`). The `collapsed` array holds row ids.
- Initial state per row: previous form state wins, then preferences
  (`collapsedPrefs.includes(row.id)`), then `field.admin.initCollapsed`
  (`ui/forms/fieldSchemasToFormState/isRowCollapsed.js:1-17`, called from
  `addFieldStatePromise.js:395-403`).

Recipe for a plugin component inside the Form:

1. `const [fields, dispatchFields] = useAllFormFields()` (or `useForm().getFields()`
   and `useForm().dispatchFields` for non-subscribing access) and
   `const { setDocFieldPreferences } = useDocumentInfo()`.
2. Find the target: the entry whose `rows` contains the id, giving `blocksPath`
   and `rowIndex`; the row path is `${blocksPath}.${rowIndex}`.
3. Walk ancestors by splitting the row path: for `layout.0.columns.1`, the
   ancestors are (`layout`, 0) and (`layout.0.columns`, 1). Any prefix whose state
   entry has `rows` is a blocks or array ancestor.
4. For each ancestor (outermost first) whose `rows[index].collapsed` is true:
   `dispatchFields({ type: 'SET_ROW_COLLAPSED', path, updatedRows: rows.map(r => r.id === id ? { ...r, collapsed: false } : r) })`
   and `setDocFieldPreferences(path, { collapsed: updatedRows.filter(r => r.collapsed).map(r => r.id) })`.
   Copy rows instead of mutating like `rowHelpers.js` does.
5. Wait for the DOM: after dispatch, the inner div loses `display: none` at once,
   height animates for 300 ms, and `RenderIfInViewport` mounts nested content on
   the next intersection callback. Poll with `requestAnimationFrame` or a
   `MutationObserver` for `#<dashes>-row-<n>`, scrolling to the deepest ancestor
   that exists so the observer fires, then to the target.

`useCollapsible()` (`ui/elements/Collapsible/provider.js:5-35`) exposes
`isCollapsed`, `isVisible` (false if any ancestor collapsible is collapsed) and
`toggle`, but only to components rendered inside that collapsible, for example a
block `Label` override. `toggle` flips the state and calls `onToggle(!isCollapsed)`
(`Collapsible/index.js:44-49`).

Other collapsible ancestors are not in form state:

- The `collapsible` field keeps its state locally (`initCollapsed: collapsedOnMount`,
  `ui/fields/Collapsible/index.js:51, 136`) and persists a boolean
  `fields[path].collapsed` preference (`66-90`, key `collapsible-<path with __>`
  when unnamed, `52`). The only programmatic expand is clicking its
  `button.collapsible__toggle` in the DOM (`Collapsible/index.js:99-105`); the field
  container has `id="field-collapsible-<path with __>"` (`fields/Collapsible/index.js:119`).
- The `tabs` field renders only the active tab's fields
  (`ui/fields/Tabs/index.js:107-109, 361-368`); a row inside an inactive tab has no DOM.

Both are outside the v1 "blocks only" scope but decide whether locate can fail.

## 4. Detecting focus or a click inside a row and resolving it to a row id and path

There is no `useFieldProps` in 3.88; the exports are `FieldPathContext` and
`useFieldPath` (`ui/exports/client/index.d.ts:13`,
`ui/forms/RenderFields/context.js:25-38`). `RenderFields` wraps every field in
`FieldPathContext` with its computed path (`ui/forms/RenderFields/index.js:80-93`).
`useField` resolves `path` as `options.path || useFieldPath() || potentiallyStalePath`
(`ui/forms/useField/index.js:31-32`, rationale in `ui/forms/useField/types.d.ts:5-22`):
paths change on reorder while props stay stale until the server re-renders. Resolve
ids at event time, never at mount.

Two workable approaches:

DOM traversal from a form-level listener (no per-field config changes):

1. `const { formRef } = useForm()` (`ui/forms/Form/types.d.ts:227`; the ref is set on
   the `<form>` element at `ui/forms/Form/index.js:139, 613, 695-708`). Attach
   `focusin` and `click` listeners to `formRef.current`; `focusin` bubbles, `click`
   covers non-focusable header areas. The drag handle is focusable
   (`tabIndex 0` from dnd-kit) and the toggle is a `button`.
2. From `event.target`, `closest('.blocks-field__row')` is the innermost row's
   collapsible; its `parentElement` is the `#<dashes>-row-<n>` wrapper
   (`BlockRow.js:107-113`). Parse `/-row-(\d+)$/` for `rowIndex`.
3. `wrapper.closest('.blocks-field')` is the field container; its id
   `field-<path with __>` gives `blocksPath` after replacing `__` with `.`
   (`ui/fields/Blocks/index.js:304`).
4. `fields[blocksPath].rows[rowIndex].id` is the row id, `fields[blocksPath].rows[rowIndex].blockType`
   the block slug; ancestors come from repeating step 2-3 on the wrapper's parent.

Context-based, per row (requires overriding `admin.components.Label` on every block
in scope): a client component rendered as the row label can call `useRowLabel()`
(`ui/forms/RowLabel/Context/index.js:33-35`, export at
`ui/exports/client/index.d.ts:190`), which returns `{ data, path, rowNumber }` with
`path` the row path and `data = getDataByPath(rowPath)`, the row object including
`id`, `blockType` and `blockName` (`Context/index.js:16-27`,
`payload/utilities/getDataByPath.js:2-14`). It can also read `useCollapsible()` for
its own row. The label is server-rendered per row, so it re-renders only when the
row's `lastRenderedPath` changes (`renderField.js:118-122`), and overriding it
collides with a user's existing `Label`.

## 5. Reaching the Live Preview iframe and context

`useLivePreviewContext()` is exported (`ui/exports/client/index.d.ts:321`) and
returns `LivePreviewContextType` (`ui/providers/LivePreview/context.d.ts:6-74`):
`iframeRef: RefObject<HTMLIFrameElement | null>` (line 10), `popupRef`,
`previewWindowType: 'iframe' | 'popup'`, `url`, `loadedURL`, `appIsReady`,
`isLivePreviewing`, `isLivePreviewEnabled`, `shouldRenderIframe`, `setURL`, sizes.

- The ref is created in the provider (`ui/providers/LivePreview/index.js:62`) and
  attached to `IframeLoader` in `LivePreviewWindow` with
  `id="live-preview-iframe"` and `className="live-preview-iframe"`
  (`ui/elements/LivePreview/Window/index.js:107-118`). `document.getElementById('live-preview-iframe')`
  also works but the ref is the supported handle.
- Payload posts to the preview with
  `iframeRef.current.contentWindow?.postMessage(message, url)` (iframe) or
  `popupRef.current.postMessage(message, url)` (popup)
  (`Window/index.js:64-71, 86-93`). Messages are
  `{ type: 'payload-live-preview', collectionSlug, data, externallyUpdatedRelationship, globalSlug, locale }`
  (`56-63`) and `{ type: 'payload-document-event' }` (`83-85`). A plugin should use
  its own `type` values and the same `url` as target origin.
- Ready handshake: the provider listens on `window` for
  `event.data.type === 'payload-live-preview' && event.data.ready`, gated by
  `url.startsWith(event.origin)`, and sets `appIsReady`
  (`ui/providers/LivePreview/index.js:152-165`). Payload only streams after
  `isLivePreviewing && appIsReady` (`Window/index.js:46-48`). A plugin listener on
  `window` should filter `event.source === iframeRef.current?.contentWindow` and
  the same origin check.
- The iframe is rendered lazily and never unmounted once shown
  (`shouldRenderIframe`, `ui/providers/LivePreview/index.js:25-35`, docs at
  `context.d.ts:53-58`); `loadedURL` is set from the iframe `onLoad`
  (`Window/index.js:110-112`).
- Whether Live Preview is enabled for a document is decided by
  `isLivePreviewEnabled` (root `admin.livePreview.collections/globals` or the
  entity's `admin.livePreview`) and configs are merged root-then-entity
  (`ui/utilities/handleLivePreview.js:1-28, 57-62`); the URL is resolved
  server-side (`63-94`) and passed to `LivePreviewProvider`
  (`next/views/Document/index.js:295-303, 347-354`). Docs:
  https://payloadcms.com/docs/live-preview/overview.

## 6. Getting a plugin client component into the import map

- A `PayloadComponent` string is `'<module specifier>#<exportName>'`; without `#`
  the export is `default` (`payload/bin/generateImportMap/utilities/parsePayloadComponent.js:7-13`).
  The import map key is `path + '#' + exportName` and the local identifier is
  `exportName + '_' + md5(path)` (`utilities/addPayloadComponentToImportMap.js:26-31`);
  the file is written as `import { X as X_<hash> } from '<path>'` lines plus the
  `importMap` object (`payload/bin/generateImportMap/index.js:75-83, 103`).
- Runtime lookup: `getFromImportMap` reads `importMap[path#exportName]` and logs
  "You may need to run the `payload generate:importmap` command" when missing
  (`utilities/getFromImportMap.js:3-15`).
- Discovery is a config traversal: collection edit slots and `views.edit.*.Component`
  (`iterateCollections.js:18-34`), root `providers` and `views`
  (`iterateConfig.js:52-60`), field components including `Label`, `Block`, `Field`,
  `RowLabel` and nested `blocks` (`iterateFields.js:21-29, 61-71`). Anything not
  reachable by traversal can be added through `admin.importMap.generators`
  (`payload/config/types.d.ts:585-591, 794-798`; run at `iterateConfig.js:76-86`).
- The BlurHash plugin is the in-repo pattern: the plugin sets
  `admin.components.Field: "@codlume/payload-blurhash/client#BlurHashPreview"`
  (`packages/payload-blurhash/src/plugin.ts:341-344`), `src/client.ts:1` re-exports
  the component, `package.json` exposes the `./client` subpath (`37-40`) and
  peer-depends on `@payloadcms/ui` (`73`), and the generated
  `apps/payload-cms/src/app/(payload)/admin/importMap.js:1,7` contains
  `import { BlurHashPreview as BlurHashPreview_4ba5545a6d8b60d48f901125fa998fb8 } from '@codlume/payload-blurhash/client'`.
  For this plugin the same shape applies with
  `views.edit.livePreview.Component: "@codlume/payload-live-preview/client#<Name>"`;
  the component file needs `'use client'` since it uses hooks (docs: "All Custom
  Components are React Server Components by default",
  https://payloadcms.com/docs/admin/react-hooks).

## Open points for the decision tickets

- Whether to also expand `collapsible` fields and switch `tabs` when a target row
  sits inside one (DOM click on `button.collapsible__toggle`; no form-state path).
- Whether the locate handshake waits for `RenderIfInViewport` to mount nested rows
  (poll/`MutationObserver`) or forces render by scrolling ancestors first.
- Whether the admin side listens via a form-level `focusin` listener (zero config
  intrusion) or a `Label` override (per-row context, but collides with user labels).
