# Storyblok Bridge as a reference for bidirectional block linking

Research for [#82](https://github.com/codlume/payload-toolkit/issues/82), part of the
Live Preview plugin map [#79](https://github.com/codlume/payload-toolkit/issues/79).
Read on 2026-09-02.

## Sources and how much to trust them

The two URLs named in the ticket now return 404
(`/docs/guide/essentials/visual-editor`, `/docs/Guides/storyblok-latest-js`). Their
current replacements are the
[Visual Editor concept page](https://www.storyblok.com/docs/concepts/visual-editor) and
the [`@storyblok/preview-bridge` reference](https://www.storyblok.com/docs/libraries/js/preview-bridge).

The bridge is no longer a closed CDN-only script. It is published to npm as
`@storyblok/preview-bridge` (2.3.0, modified 2026-08-24), and the npm tarball ships the
same 25,275-byte `storyblok-v2-latest.js` that the CDN serves
([unpkg file listing](https://unpkg.com/@storyblok/preview-bridge@2.3.0/?meta),
[CDN script](https://app.storyblok.com/f/storyblok-v2-latest.js), `Last-Modified: 24 Aug 2026`).
The tarball also ships `.d.ts` files with doc comments, which is where most of the exact
payload shapes below come from. The bridge's TypeScript source is still not in the
public monorepo (no `packages/preview-bridge` in
[monoblok/packages](https://github.com/storyblok/monoblok/tree/main/packages)); an older
request to open-source it was closed without doing so
([storyblok#489](https://github.com/storyblok/storyblok/issues/489)).

Trust order used here:

1. The bridge script itself (class method names are not minified, so `handleWindowClick`,
   `enterComponent`, etc. are quoted by name) and its published types.
2. SDK sources in the [monoblok monorepo](https://github.com/storyblok/monoblok):
   `packages/js`, `packages/live-preview`, `packages/react`.
3. Official docs pages.
4. GitHub issues for pain points.

## 1. What `storyblokEditable()` emits

**The `_editable` comment.** The draft version of the Content Delivery API attaches a
private `_editable` string to every block; the published version does not
([concept page](https://www.storyblok.com/docs/concepts/visual-editor)). Its format is an
HTML comment wrapping JSON:

```html
<!--#storyblok#{"name": "column", "space": "48408", "uid": "7c44c5d8-0adb-4c01-a797-12d9b300b99b", "id": "307934"}-->
```

The four fields are `name` (the block's component name), `space` (numeric space ID),
`uid` (the block's `_uid`) and `id` (the numeric story ID)
([concept page](https://www.storyblok.com/docs/concepts/visual-editor),
[FAQ: parsing editable comments](https://www.storyblok.com/faq/how-to-parse-the-editable-comments)).
The bridge's own parser types `space` as optional and the rest as required
([`editable/parsing.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/editable/parsing.d.ts)).

**The two attributes.** `storyblokEditable(blok)` strips the comment markers, parses the
JSON and returns exactly two attributes, or `{}` when `_editable` is missing or malformed
([`packages/js/src/editable.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/editable.ts),
identical logic in
[`packages/live-preview/src/editable.ts`](https://github.com/storyblok/monoblok/blob/main/packages/live-preview/src/editable.ts)):

```ts
{
  "data-blok-c": JSON.stringify(options),          // the parsed JSON re-stringified
  "data-blok-uid": `${options.id}-${options.uid}`, // "<storyId>-<block _uid>"
}
```

So `data-blok-c` is the click payload and `data-blok-uid` is the lookup key. The bridge
finds an element for a given block with
`document.querySelector('[data-blok-uid="<storyId>-<uid>"]')` (first match only) and
resolves a click by walking from `event.target` up through `parentNode` until it finds an
element with `data-blok-c`, then `JSON.parse`s that attribute
([bridge script](https://app.storyblok.com/f/storyblok-v2-latest.js), helpers `a`, `d`, `h`
at the top of the IIFE). The `storyblok__outline` class is optional for developers
([js-sdk reference](https://www.storyblok.com/docs/libraries/js/js-sdk)); the bridge's
injected CSS targets both `.storyblok__outline` and `[data-blok-c]`, so the class adds
nothing when the attributes are present.

**Nested components.** There is no parent/child encoding in the markup. Every block at
every depth has its own `_editable`, and the developer spreads `storyblokEditable(blok)`
on each component's root element
([react-sdk reference](https://www.storyblok.com/docs/libraries/js/react-sdk)). Nesting is
resolved at click time by the closest-marked-ancestor walk above, so the innermost marker
under the cursor wins. The parent chain is not derived in the preview at all: after a
click, the editor answers with an `editedBlok` message whose `breadcrumbs` array
(`{_uid, component, _parentindex?, _parentUid?, _parentfield?, _parentName?}`) the
bridge renders as a breadcrumbs menu
([`internal/types.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/internal/types.d.ts),
`updateBreadcrumbsMenu` in the script).

**Identity scope.** A block's `_uid` is unique only within one story; story `uuid` +
`_uid` is the fully unique pair. Copy/pasting a story deliberately keeps the same `_uid`s
([storyblok#137](https://github.com/storyblok/storyblok/issues/137), maintainer comment).
That is why the lookup key is `id-uid`, not `uid` alone.

**Comment-decoration fallback.** If a page contains the raw `<!--#storyblok#…-->` comments
instead of attributes, `enterEditmode` walks the DOM with a `NodeIterator`
(`SHOW_COMMENT`), and for each comment sets `data-blok-c`/`data-blok-uid` on the next
element sibling, forces `min-height: 5px` when `offsetHeight < 5`, adds
`storyblok__outline`, and remembers the element so `destroy()` can undo all of it
([bridge script](https://app.storyblok.com/f/storyblok-v2-latest.js), `enterEditmode`,
`_decoratedElements`; [`bridge-private.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/bridge-private.d.ts)
documents `init()` as "Transform comments in the DOM to data-blok-c and data-blok-uid").

**Display names.** The `enterEditmode` payload carries
`componentNames: Record<name, display_name>`; the bridge rewrites `name` inside
`data-blok-c` to the display name and uses it for the overlay label
([`BridgeEvent.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/BridgeEvent.d.ts),
`enterEditmode` and `updateComponentLabel` in the script). This closed the request to
show display names instead of technical names
([storyblok#113](https://github.com/storyblok/storyblok/issues/113)).

**What the developer must do.**

- Fetch the `draft` version so `_editable` exists, and spread the attributes on a real
  DOM element. Component-library components that do not forward unknown props need a
  wrapper `div`
  ([monoblok#68](https://github.com/storyblok/monoblok/issues/68) and its Svelte twin
  [storyblok-svelte#901](https://github.com/storyblok/storyblok-svelte/issues/901)).
- Load the bridge once and subscribe (`useStoryblokBridge(storyId, cb, options)` or the
  newer `onStoryblokEditorEvent(cb, options)`)
  ([js-sdk reference](https://www.storyblok.com/docs/libraries/js/js-sdk),
  [`live-preview` README](https://github.com/storyblok/monoblok/blob/main/packages/live-preview/README.md)).
- Serve the preview over HTTPS and allow framing:
  `Content-Security-Policy: frame-ancestors https://app.storyblok.com`
  ([concept page](https://www.storyblok.com/docs/concepts/visual-editor)).

## 2. Bridge events

The bridge is an event emitter keyed by the `action` field of incoming `postMessage`
data: `receiveMessageFromApp` does `emit(e.data.action, e.data)` for any message that has
an `action`, with no `origin` check on inbound messages
([bridge script](https://app.storyblok.com/f/storyblok-v2-latest.js), `receiveMessageFromApp`).
Outbound messages go to `window.parent.postMessage(payload, targetOrigin)` where
`targetOrigin` is `customParent`, or `https://app-beta.storyblok.com` when the URL has
`_storyblok_env=stage`, or `https://app.storyblok.com` (`targetOrigin` getter).

The constructor's `events` map lists every inbound event the bridge accepts. Only four
are documented on the reference page
([preview-bridge reference](https://www.storyblok.com/docs/libraries/js/preview-bridge)).
Payloads below are from
[`BridgeEvent.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/BridgeEvent.d.ts)
and [`internal/types.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/internal/types.d.ts).

| Event                                           | Payload (besides `action`)                                                                                                            | Carries block identity            | Documented                |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ------------------------- |
| `input`                                         | `story` (the whole updated story)                                                                                                     | no (whole story)                  | yes                       |
| `change`                                        | `reload: true, slug, storyId, slugChanged?`                                                                                           | story only                        | yes                       |
| `published`                                     | `slug, storyId, slugChanged`                                                                                                          | story only                        | yes                       |
| `unpublished`                                   | `slug, storyId`                                                                                                                       | story only                        | no                        |
| `enterEditmode`                                 | `reload: true, blockId, storyId, componentNames, appVersion: 'v1' \| 'v2'`                                                            | `blockId` = selected block `_uid` | yes                       |
| `enterComponent`                                | `componentId, storyId, breadcrumbs, blok: {uid, id, space, name}, canAddBlocks?, canMoveForward?, canMoveBackward?, canDeleteBlocks?` | yes, `componentId`                | no                        |
| `hoverComponent`                                | `componentId, storyId`                                                                                                                | yes                               | no                        |
| `highlightComponent`                            | `componentIds: string[], componentId, storyId`                                                                                        | yes, many                         | no                        |
| `editedBlok`                                    | `breadcrumbs, blok, can*` flags                                                                                                       | `blok.uid`                        | no                        |
| `deselectBlok`                                  | untyped                                                                                                                               | no                                | no                        |
| `addedBlock` / `movedBlock` / `duplicatedBlock` | `blockId`                                                                                                                             | yes                               | no                        |
| `deletedBlock`                                  | untyped                                                                                                                               | no                                | no                        |
| `customEvent`                                   | `event: 'start-sync'`                                                                                                                 | no                                | no                        |
| `pingBack`                                      | none                                                                                                                                  | no                                | no (used by `pingEditor`) |
| `sessionReceived`, `viewLiveVersion`            | untyped, never handled internally                                                                                                     | no                                | no                        |

Outbound actions the preview sends to the editor
([`BridgeAction.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/BridgeAction.d.ts),
`OutboundMessage` in `internal/types.d.ts`): `initialized` (with the resolved config),
`ping`, `edit` (`dataC: {uid, id, space, name}` from the clicked `data-blok-c`, plus
config), `noFocus`, and the block actions `addBlockBefore`, `addBlockAfter`,
`duplicateBlock`, `copy`, `moveForward`, `moveBackward`, `deleteBlock` (each with the
`_uid`/`_parentUid`/`_parentfield` of the last breadcrumb).

Behavioural details attached to events:

- Subscribing to `input` flips `actionsEnabled`, which is what makes the actions menu
  appear in the overlay (`subscribeEvent` in the script; the docs put it as "When the
  input event is configured, the menu also displays editing actions",
  [concept page](https://www.storyblok.com/docs/concepts/visual-editor)).
- The SDK helper reacts to `change` and `published` with `window.location.reload()` and
  to `input` by calling back with `event.story` only when `event.story.id` matches the
  subscribed story id
  ([`packages/js/src/index.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/index.ts),
  [`onStoryblokEditorEvent.ts`](https://github.com/storyblok/monoblok/blob/main/packages/live-preview/src/onStoryblokEditorEvent.ts)).
- `on()` has no `off()`; the request for one
  ([monoblok#30](https://github.com/storyblok/monoblok/issues/30)) was answered by a
  `destroy()` method that removes listeners, timers, injected DOM and styles
  ([`bridge.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/bridge.d.ts)).

## 3. Hover and click inside the preview

**Injected DOM.** On init the bridge appends a `<style id="storyblok-bridge-stylesheet">`
to `<head>` and three absolutely positioned, `pointer-events: none` `div`s to `<body>`
([bridge script](https://app.storyblok.com/f/storyblok-v2-latest.js), CSS template `y`,
`createHinter`, `createHighlighter`, `createOverlay`):

| Element     | Class                                                | Purpose                                                         | Style                                                                             |
| ----------- | ---------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| hinter      | `storyblok__hint`                                    | shown when the editor sidebar hovers a block (`hoverComponent`) | `outline: 1px solid #05807f; z-index: 16777272`                                   |
| highlighter | `storyblok__highlight` (container, one child per id) | multi-select from sidebar checkboxes (`highlightComponent`)     | `background: rgba(89,197,198,0.2); outline: 1px solid #05807f; z-index: 16777270` |
| overlay     | `storyblok__overlay`                                 | frames the selected block; hosts the toolbar                    | `outline: 1px solid #05807f; box-shadow…; z-index: 16777273`                      |

The overlay's child toolbar `.storyblok__overlay-menu` is the only part with
`pointer-events: auto`; it holds the label, a breadcrumbs button (parent chain) and an
actions button, sits at `top: -40px`, and flips to the bottom (`--bottom` class) when the
element's top is within 30px of the viewport top (`calculateElementPosition`).

**Positioning.** Every overlay is positioned by `getBoundingClientRect()` plus page scroll
offsets and given `min-height: 5px` (`getElementOffset`, `calculateElementPosition`). The
selected-block overlay is re-positioned by a `setInterval` every 300 ms for as long as
edit mode is active (`calcInterval` in `enterEditmode`). There is no `ResizeObserver` or
scroll listener.

**Hover.** There is no per-element hover state. A `mousemove` listener on `document` adds
`storyblok--outlined` to `<body>` and schedules its removal 800 ms later (reset on every
move), and the hinter fades with it (`outlineOnMoveHandler`). While the class is present,
CSS gives every marked element a faint dashed outline and removes it from the focused one:

```css
.storyblok--outlined .storyblok__outline,
.storyblok--outlined [data-blok-c] {
  outline: 1px dashed rgba(182, 186, 191, 0.5);
}
.storyblok--outlined [data-blok-c][data-blok-focused="true"] {
  outline: 0;
}
```

So "hover" is a body-class toggle driven by mouse movement, not hit-testing; the only
per-element outline comes from CSS on the marker attribute.

**Click.** One delegated listener, `window.addEventListener('click', handleWindowClick)`,
is registered when `enterEditmode` arrives. It runs in the bubbling phase on `window`, so
element-level handlers (including framework `<Link>` components that call
`preventDefault()` and push a client-side route themselves) have already run by the time
the bridge sees the event. `handleWindowClick` then:

1. If `preventClicks` is true: `preventDefault()` + `stopPropagation()` for every click,
   marker or not.
2. `handleOpenBlok(target, event)`: walk up to the closest `data-blok-c`. If found and its
   `uid` differs from the currently selected one, `preventDefault()` +
   `stopPropagation()`; record `currentUid`/`storyId`; post `edit` with the parsed
   `data-blok-c` as `dataC`. A second click on the already selected block does not call
   `preventDefault`, so a link inside it navigates.
3. If no marker ancestor: deselect (remove all `data-blok-focused`, hide overlay) and post
   `noFocus` (`toggleFocusElement`).

Selection is confirmed by the editor, not the preview: the editor answers `edit` with
`editedBlok`, and only then does the bridge set `data-blok-focused="true"` on the element,
show the overlay over `[data-blok-uid="storyId-uid"]`, update the label and breadcrumbs,
and add `storyblok__overlay--clicked` for 400 ms, which runs a single 0.2 s `smoke`
keyframe (background from transparent to teal) once (`handleEditedBlok`,
`updateComponentBase`; `.storyblok__overlay--clicked { animation-iteration-count: 1 }`).

**Native links.** `preventClicks` is documented as "Enable or disable interactions within
the preview area. Defaults to false"
([preview-bridge reference](https://www.storyblok.com/docs/libraries/js/preview-bridge)).
Users have reported since 2021 that links still navigate
([storyblok#645](https://github.com/storyblok/storyblok/issues/645),
[monoblok#29](https://github.com/storyblok/monoblok/issues/29) open since 2023-03,
[monoblok#82](https://github.com/storyblok/monoblok/issues/82) open since 2023-11). A
Storyblok employee relayed the team's explanation: "The bridge is not preventing the
clicks of the links outside of the block tree. In the bridge code, the preventClicks
config is only checked when the user is clicking on a block"
([monoblok#82 comment](https://github.com/storyblok/monoblok/issues/82)). The current
script checks the flag before the block lookup, so the surviving failure mode is the
listener order described above (inference from the code; Nuxt and Next reporters in both
threads match it). Community workarounds: `body.is-storyblok-editor a { pointer-events:
none }` keyed on the `_storyblok` param, replacing `<a>` with `<div>` in the editor, or a
click-blocking overlay inside the link component
([monoblok#82](https://github.com/storyblok/monoblok/issues/82)).

## 4. Editor to preview: scroll and highlight

Docs: "Click on a block in the editor to scroll to the corresponding element in the
preview area, or click on an element in the preview to open the block in the editor"
([concept page](https://www.storyblok.com/docs/concepts/visual-editor)). The mechanics,
from the script and `bridge-private.d.ts` doc comments:

- **`enterComponent`** ("triggered when navigation to block from sidebar"): look up
  `[data-blok-uid="storyId-componentId"]`, hide the hinter, set `currentUid`, then
  `scrollIntoView` only if the element is not already vertically in the viewport
  (helper `f` tests `rect.top`/`rect.height` against `innerHeight`), after a 100 ms
  `setTimeout`, with `{behavior: 'smooth', block: 'start'}`; then the same
  `handleEditedBlok` path as a click (overlay, label, one-shot flash)
  (`enterComponent`, `scrollIntoView`).
- **`hoverComponent`** ("Show hinter when hovering block in the sidebar"): position the
  hinter over the element and fade it in; no scroll (`hoverComponent`).
- **`highlightComponent`** ("Highlights component when selecting in the sidebar via
  checkbox"): clear the highlighter, append one `.storyblok__highlight` child per id in
  `componentIds`, and for the primary `componentId` call plain `scrollIntoView()`
  (instant) when off-screen (`highlightComponent`).
- **`addedBlock` / `movedBlock`**: open `storyId-blockId` immediately;
  **`duplicatedBlock`**: deselect, then open after 500 ms (`handleAddMoveBlok`,
  `handleDuplicatedBlok`).
- **`deselectBlok`**: strip every `data-blok-focused` and hide the overlay
  (`handleDeselectBlock`).
- **`enterEditmode` with `blockId`** plus the undocumented `setActiveBlock` config
  ("honoured at runtime but absent from BridgeParams",
  [`internal/types.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/internal/types.d.ts))
  opens that block on load.

Nothing in this direction steals focus: the bridge never calls `focus()`; it only sets an
attribute and moves positioned `div`s.

## 5. Staying inert outside the editor, and loading

**Inside the script.** `isInIframe` is `window.top !== window.self`. `init()` registers
nothing (no `message`/`mousemove`/`click` listeners, no styles, no DOM) unless the page is
framed, and it also skips when `initOnlyOnce` (default `true`) finds an existing
`.storyblok__hint` in the DOM. Only when framed does it post `{action: 'initialized',
config}` to the parent (`init`). `pingEditor(cb)` posts `ping` when framed and calls `cb`
on `pingBack`; when not framed it sets `inEditor = false` and calls `cb` immediately,
which is why the docs say `isInEditor()` "can only run in the callback function of
`pingEditor()`" ([preview-bridge reference](https://www.storyblok.com/docs/libraries/js/preview-bridge)).
The script reads no `_storyblok*` query parameter except `_storyblok_env` (stage origin).

**In the SDK layer** the query-parameter gates live:

- `storyblokInit` loads the bridge only when `window.location.search` includes
  `_storyblok_tk`, with a comment pointing at the validation FAQ
  ([`packages/js/src/index.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/index.ts)).
- `window.storyblokRegisterEvent(cb)` warns "You are not in Draft Mode or in the Visual
  Editor." and returns unless the search string includes `_storyblok`
  ([`packages/js/src/bridge.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/bridge.ts)).
- `useStoryblokBridge(id, cb)` returns early unless the bridge is loaded and
  `?_storyblok=<id>` equals the story being rendered (`inStory`)
  ([`packages/js/src/index.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/index.ts)).
- React RSC live editing renders nothing unless
  `isVisualEditor() = isBrowser() && window.self !== window.top && location.search.includes('_storyblok')`
  ([`packages/react/src/utils.ts`](https://github.com/storyblok/monoblok/blob/main/packages/react/src/utils.ts),
  [`rsc/live-editing.tsx`](https://github.com/storyblok/monoblok/blob/main/packages/react/src/rsc/live-editing.tsx)).
- The newest helper requires `_storyblok`, `_storyblok_c` and `_storyblok_tk[space_id]`
  all present, optionally matching a space id
  ([`live-preview/src/utils/isInEditor.ts`](https://github.com/storyblok/monoblok/blob/main/packages/live-preview/src/utils/isInEditor.ts)).

**Query parameters the editor appends** (typed in
[`PreviewSearchParams.d.ts`](https://unpkg.com/@storyblok/preview-bridge@2.3.0/dist/types/PreviewSearchParams.d.ts)):
`_storyblok` (story id), `_storyblok_c` (root component name), `_storyblok_lang`,
`_storyblok_release`, `_storyblok_rl` (iframe creation timestamp),
`_storyblok_tk[space_id]`, `_storyblok_tk[timestamp]`, `_storyblok_tk[token]` (a
preview-scoped Delivery API token), `_storyblok_version`. The secure server-side check is
`sha1("<space_id>:<preview_token>:<timestamp>") === token` with the timestamp within
3600 s ([FAQ](https://www.storyblok.com/faq/how-to-verify-the-preview-query-parameters-of-the-visual-editor)).

**Loading.** Historically a `<script>` from the CDN
(`https://app.storyblok.com/f/storyblok-v2-latest.js`,
[concept page](https://www.storyblok.com/docs/concepts/visual-editor)). Today `@storyblok/js`
bundles `@storyblok/preview-bridge` and loads it with a dynamic `import()` on demand,
queueing `storyblokRegisterEvent` callbacks until it resolves and exposing
`window.StoryblokBridge` for legacy code; `bridgeUrl` is deprecated because "the Storyblok
bridge is now bundled and is no longer loaded from a CDN URL"
([`bridge.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/bridge.ts),
[`index.ts`](https://github.com/storyblok/monoblok/blob/main/packages/js/src/index.ts)).
`@storyblok/live-preview` does the same import per call, installs the legacy globals as
deprecating getters, and forces `initOnlyOnce: false` because the default "silently skips
`addMessageListener()` when a `.storyblok__hint` element is already in the DOM (left by a
prior instance), making any second concurrent subscription permanently deaf to editor
events" ([`onStoryblokEditorEvent.ts`](https://github.com/storyblok/monoblok/blob/main/packages/live-preview/src/onStoryblokEditorEvent.ts)).

**Teardown.** `destroy()` reference-counts instances and, when the last one goes, removes
the body class, all `data-blok-focused`, the three overlays and the stylesheet, and
un-decorates comment-derived elements (restoring `min-height`)
([bridge script](https://app.storyblok.com/f/storyblok-v2-latest.js), `destroy`).

## 6. Pain points developers report

- **Links navigate instead of selecting.** Open for years; see section 3
  ([storyblok#645](https://github.com/storyblok/storyblok/issues/645),
  [monoblok#29](https://github.com/storyblok/monoblok/issues/29),
  [monoblok#82](https://github.com/storyblok/monoblok/issues/82)).
- **Attributes swallowed by UI-library components.** `storyblokEditable` returns props; a
  component that does not forward them renders no marker. Fix is a wrapper `div`
  ([monoblok#68](https://github.com/storyblok/monoblok/issues/68),
  [storyblok-svelte#901](https://github.com/storyblok/storyblok-svelte/issues/901)).
- **Draft/published mismatch on first load (the "hydration" shaped bug).** With SSG the
  server payload was fetched as `published` (no `_editable`), so `v-editable` added
  nothing until the first bridge `input` replaced the story; keying the data fetch by
  version fixed it ([monoblok#76](https://github.com/storyblok/monoblok/issues/76)). I
  found no report of the attributes themselves causing React hydration warnings; they are
  a pure function of `_editable`, so server and client agree whenever they fetch the same
  version.
- **Next.js App Router, production builds.** Dev works; production (Vercel or local
  `next build`) shows "editable components are shortly highlighted with a white border,
  but never blue and can't be clicked", the bridge script loads, no console errors;
  Storyblok asked reporters to move to Discord and the issue stays open
  ([monoblok#37](https://github.com/storyblok/monoblok/issues/37)). Older variants:
  bridge works in dev, not prod
  ([storyblok-react#113](https://github.com/storyblok/storyblok-react/issues/113)); a
  draft-mode redirect dropped the `_storyblok*` params so the SDK never loaded the bridge,
  fixed by forwarding `searchParams` on the 307
  ([storyblok-react#1171](https://github.com/storyblok/storyblok-react/issues/1171)).
- **`use client` boundaries and component registries.** `StoryblokComponent` inside a
  `"use client"` component could not find registered components unless `storyblokInit`
  ran inside that client boundary too
  ([storyblok-react#1161](https://github.com/storyblok/storyblok-react/issues/1161)).
- **Hook hygiene.** `useStoryblokBridge` is not a React hook; calling it in render
  re-subscribed every render, `useEffect` was conditional, subscriptions were never
  cleaned up, and two subscribers with different ids made the second one `reload()` the
  window ([storyblok-react#112](https://github.com/storyblok/storyblok-react/issues/112)).
  The current `useStoryblokState` subscribes in an effect keyed on `story.id` and ignores
  stale bridge stories
  ([`core/use-storyblok-state.ts`](https://github.com/storyblok/monoblok/blob/main/packages/react/src/core/use-storyblok-state.ts)).
- **One story per page.** With two stories on a page only the first was live, because
  the helper filters `input` by `?_storyblok=<id>`
  ([storyblok-nuxt#251](https://github.com/storyblok/storyblok-nuxt/issues/251)).
- **Duplicate `_uid`s.** Expected after copy/paste ([storyblok#137](https://github.com/storyblok/storyblok/issues/137)); since lookup is `querySelector` first-match, duplicates within one page resolve to the first element (inference from the script).
- **Double script injection** in the Astro integration
  ([storyblok-astro#943](https://github.com/storyblok/storyblok-astro/issues/943)) and a
  singleton trap via `initOnlyOnce` (section 5).
- **Origin problems.** `postMessage` target-origin mismatch when the site is served
  through a proxy/redirect ([storyblok#81](https://github.com/storyblok/storyblok/issues/81)).
  Inbound messages are not origin-checked at all (section 2).
- **Iframe inside iframe.** No issue found. Structurally the bridge talks to
  `window.parent` and tests `window.top !== window.self`, so a preview nested one frame
  deeper would post to the intermediate frame, not the editor (inference from the
  script). Cookie-related iframe trouble is documented separately for Next preview mode
  ([FAQ](https://www.storyblok.com/faq/next-js-preview-iframes)).
- **Portals.** No issue found. A portal target outside the marked subtree has no marked
  ancestor, so clicks there deselect (`noFocus`) rather than select (inference from
  `handleOpenBlok`).

## What to borrow, what to avoid

For `@codlume/payload-live-preview`: a helper that must be inert on production pages, a
CSS-only hover, click-to-locate in Admin, admin-to-preview scroll and one-shot highlight,
and no continuously repainting animation.

### Borrow

- **Two-attribute marker, one for lookup and one for payload.** Storyblok's
  `data-blok-uid="<story>-<uid>"` is the selector key and `data-blok-c` is the message
  body. Keep a single stable lookup attribute whose value is unique per page (Payload
  analogue: collection or global slug + document id + block id, since block ids are
  unique per document like `_uid` per story). A payload attribute is optional; the bridge
  can reconstruct it from the key.
- **Closest-marked-ancestor resolution with one delegated listener.** No per-block
  listeners, nesting resolved at click time, innermost wins. The parent chain is
  supplied by the editor side (breadcrumbs), which maps well to Payload form state owning
  the block tree.
- **Hover as CSS on the marker attribute, scoped by a root class set once.** Storyblok
  gets close (`.storyblok--outlined [data-blok-c] { outline }`) but drives the class from
  `mousemove` plus an 800 ms timer. Set the class once after the handshake and use
  `[data-…]:hover { outline }` instead: zero listeners, zero timers.
- **Scroll only when off-screen, smooth, `block: 'start'`**, then a one-shot highlight
  (`animation-iteration-count: 1`, class removed after ~400 ms). This is exactly the
  admin-to-preview gesture in the map and it never steals focus.
- **`window.self !== window.top` gate plus an explicit handshake** (`initialized`/`ping`
  to `pingBack`). Register nothing until both hold. Storyblok's SDKs add a URL-parameter
  gate on top; Payload's iframe URL is Payload's, so the handshake is the reliable
  signal (see the Live Preview internals ticket for what Payload posts).
- **Discriminated `action` unions in both directions** (`BridgeEvent`, `BridgeAction`).
  Cheap to type, easy to debug-log.
- **`destroy()` that undoes everything and a cleanup return** from the subscribe
  helper. Storyblok shipped without it and paid for it (#30, #112, `initOnlyOnce` trap).
- **Display-name map sent once at handshake** so the preview can label blocks with Admin
  labels without shipping config to the frontend.
- **Highlight many, scroll to one** (`highlightComponent` with `componentIds` +
  `componentId`) is the right shape for the "one block rendered by several components"
  edge case: use `querySelectorAll`, outline all, scroll to the first.

### Avoid

- **Polling geometry.** The 300 ms `setInterval` that re-positions the selected overlay
  is a permanent timer for the whole editing session. Prefer `outline` on the marked
  element itself (no positioned overlay, no repositioning) and, if an overlay is ever
  needed, position it once per event and on `scroll`/`resize`/`ResizeObserver` only.
- **A blanket `preventClicks`.** Cancelling every click from a window-level bubble
  listener cannot beat element-level router handlers and has been "not working" for
  three years. Decide per click inside a marker, or make click additive (locate in Admin
  without suppressing navigation) and let a decision ticket pick the policy.
- **Unchecked inbound `postMessage`.** Verify `event.source === window.parent` and
  `event.origin` against the Admin origin before emitting.
- **Comment-based decoration at init** (NodeIterator over `#storyblok#` comments, forced
  `min-height`). Payload data is not CDN JSON with embedded comments; render attributes
  directly.
- **Block-mutation toolbar in the preview** (add/move/duplicate/delete). Out of scope for
  v1 per the map; note only that Storyblok gates it on the `input` subscription.
- **Marker helpers that require a wrapper element without saying so.** Document the "spread
  on a real DOM element" rule up front and consider a React helper that returns props
  plus an optional wrapper component for library components that drop unknown props.
- **First-match `querySelector`** when duplicates are possible; use `querySelectorAll`.
- **Coupling inertness to URL parameters alone.** Storyblok's own layers disagree
  (`_storyblok_tk` vs `_storyblok` vs three params), and a lost param on redirect
  silently disabled everything (#1171). Handshake-first avoids that class of bug.
