# Drafts, publishing, and preview

Pages use Payload drafts with autosave. An editor changes a page as a draft, and visitors keep seeing the published version until the editor publishes. Signed-in editors can preview the draft on the frontend through `/preview`.

## Sub-features

- `drafts-status` shows the document status (`Draft`, `Published`, or `Changed`) in the edit view.
- `drafts-autosave` saves edits as a draft within about a second, and `Save Draft` saves on demand.
- `drafts-publish` makes the latest draft public with `Publish changes`.
- `drafts-revert` discards the draft with `Revert to published`.
- `drafts-public-read` serves only published content to anonymous visitors at `/pages/<slug>` and `/pages-client/<slug>`.
- `drafts-preview-route` lets a signed-in editor see the draft through `/preview?slug=<slug>[&mode=client]`.

## How to get to it (user POV)

- Open `<origin>/admin/collections/pages/<id>` and edit a field.
- Choose `Save Draft`, `Publish changes`, or `Revert to published` in the document controls.
- Open `<origin>/pages/verify` as a visitor, or `<origin>/preview?slug=verify` while signed in.
- Open the `Versions` tab to see the version history.

## Driving it with the browser tool and verify.mjs

Preconditions:

- A fresh `verify launch`, so the seeded page has a published version and a newer draft.

- **Status.** Open the seeded page. The status line reads `Status: Changed`, with the `Revert to published` button beside it.
- **Visitor before publishing.** Run `curl -s <origin>/pages/verify`. The body contains `Published block 1` and no `Draft block` text.
- **Draft read.** Run `verify api GET '/api/pages/<id>?draft=true&depth=0'`. The layout reads `Draft block 1..3` and `_status` is `draft`.
- **Autosave.** Type into `#field-layout__0__content`. Within about 1 s, `verify api GET '/api/pages/<id>?draft=true&depth=0'` returns the new text, and the public page is unchanged.
- **Publish.** Choose `Publish changes` and wait for the text `Published`. `curl -s <origin>/pages/verify` now contains `Draft block 1..3`, and `verify api GET '/api/pages/<id>?depth=0'` shows `_status: published`.
- **Preview route guard.** `curl -s -o /dev/null -w '%{http_code}' '<origin>/preview?slug=verify'` prints `401`. Signed in, the same URL redirects to `/pages/verify` and renders the draft.
- **Client route.** `<origin>/pages-client/verify` renders the same published content through the client renderer.
- **Proof.** Screenshot the status line before and after publishing, and save both `curl` bodies.
- **Automated cover.** `pnpm --filter @codlume/payload-cms exec vitest run tests/integration/pages-preview.test.ts --maxWorkers=1` after `pnpm build:packages`.

## Gotchas

- `/preview` sets the Next draft-mode cookie in the browser profile. After visiting it, `/pages/<slug>` in that profile renders the draft while you are signed in. Use `curl` or a private profile for the visitor view.
- Autosave runs every 800 ms, so a status read right after typing can still show the previous value. Poll the API instead of sleeping.
- Media also uses drafts with autosave, so uploads show `Publish changes` too.
- Payload-roles adds publish, unpublish, and trash permissions on top of drafts, but only in apps that install it. See [roles.md](./roles.md) and `docs/statecharts/document-lifecycle.md`.
