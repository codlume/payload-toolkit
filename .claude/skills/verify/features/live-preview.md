# Live preview linking

`@codlume/payload-live-preview` links blocks in Payload Admin with the components they render in the native Live Preview pane. Focusing an Admin field scrolls to its block in the preview and highlights it. Clicking a block in the preview reveals and highlights its Admin row.

## Sub-features

- `lp-connect` links the Admin form and the preview iframe once both sides load.
- `lp-admin-to-preview` focuses an Admin field, then scrolls the preview to the block and highlights it.
- `lp-preview-to-admin` clicks a preview block, then reveals and highlights its Admin row, expanding collapsed ancestors.
- `lp-hover` outlines the hovered preview block with its type label.
- `lp-nested` resolves nested blocks, and falls back to the nearest ancestor that exists.
- `lp-reset` relinks after a preview reload or a close and reopen, with no stale find left running.
- `lp-client-route` behaves the same on `/pages-client/<slug>`.
- `lp-global` links the localized Site Settings global (test context only).
- `lp-disabled` keeps the pane unlinked in `disabled-in-memory` mode.

## How to get to it (user POV)

- Open `<origin>/admin/collections/pages/<id>` and choose the `Live Preview` button. It becomes `Exit Live Preview`.
- Focus or click any block field, or click a block inside the preview pane.
- With `verify launch --test-context`, save a `siteName` at `<origin>/admin/globals/site-settings?locale=en` and open Live Preview there.

## Driving it with the browser tool and verify.mjs

Preconditions:

- A fresh `verify launch` and a signed-in browser tab at `<origin>`.
- `launch` sets `PAYLOAD_LIVE_PREVIEW_DEBUG=true`, so both sides log `[@codlume/payload-live-preview:admin]` and `[...:preview]` lines to the browser console with `console.debug`. Turn on verbose or debug levels to see them. `html[data-payload-linking]` is the reliable connect signal.

- **Start recording.** Linking is an interaction, so record a video.
- **Connect.** Open the seeded page and choose `Live Preview`. Wait for `html[data-payload-linking]` on the Admin page. The console shows `admin] connected` and `preview] connected`.
- **Admin to preview.** Click `#field-layout__2__content` (`Draft block 3`). The console shows `admin] sent locate [<id>]` and `preview] received locate [<id>]`, and the preview scrolls until `Draft block 3` is in view.
- **Arm the highlight probe.** Highlights clear after 1.2 s. Before the next action, run this in the Admin page:

  ```js
  window.__hl = [];
  new MutationObserver((ms) =>
    ms.forEach(
      (m) =>
        m.target.hasAttribute("data-payload-block-highlight") &&
        window.__hl.push(m.target.closest("[id^=layout-row]")?.id),
    ),
  ).observe(document.body, {
    attributes: true,
    subtree: true,
    attributeFilter: ["data-payload-block-highlight"],
  });
  ```

- **Preview to Admin.** Click inside the second block of the preview iframe (the block whose text is `Draft block 2`). `window.__hl` becomes `["layout-row-1"]` and row `02` turns highlighted.
- **Hover.** Move the pointer over a preview block. It gets `data-payload-block-hover`, a dashed outline, and a `TEXT` label.
- **Proof.** Stop the recording. Save it with a screenshot after each direction and the `window.__hl` value.
- **Automated cover.** Run `pnpm --filter @codlume/payload-cms test:e2e live-preview.e2e.test.ts`, or add `-g "<test name>"` for one scenario. `preview-context.e2e.test.ts` covers the global. The runner starts two dev servers, so expect 2 to 4 minutes. Unit tests: `pnpm --filter @codlume/payload-live-preview test:unit`.

## Gotchas

- Messages are dropped with `rejected plugin message: source or origin` when the browser origin differs from `PAYLOAD_PUBLIC_SERVER_URL`. Use the `localhost` origin that `launch` prints.
- The first Live Preview open compiles the frontend route and can take 15 s or more before `connected` appears.
- Reading the iframe: `document.querySelector("iframe").contentDocument` works because the preview is same-origin. Blocks carry `data-payload-block=<row id>` only in draft renders.
- Typing in a field that is already selected sends no new locate. A preview click clears the Admin selection, so focusing the same field again does send.
- Each demo text block has a `min-height` of 65vh, so only one or two blocks are visible in the preview pane at a time.
- Only the unit test `tests/unit/plugin.test.ts` asserts `lp-disabled`, and no e2e test does. Check it in the app with `verify launch --mode disabled-in-memory`: the Admin `html` never gets `data-payload-linking`.
- A preview click cancels the preview's pending find, scroll, and highlight for an earlier Admin pick. You do not need to wait for a highlight to fade before you click in the preview.
- The state model is in `docs/statecharts/live-preview-linking.md`.
