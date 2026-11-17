# BlurHash placeholders

`@codlume/payload-blurhash` stores a BlurHash placeholder on each uploaded image in the `media` collection and shows it in Admin as a small read-only preview. Clients read it as the `blurHash` field.

## Sub-features

- `bh-generate` generates a placeholder for JPEG, PNG, WebP, and AVIF uploads.
- `bh-panel` shows the BlurHash panel with a canvas preview, the value, and a status line.
- `bh-keep-on-edit` keeps the placeholder when only metadata changes.
- `bh-replace` regenerates it when the file is replaced, and clears it when the file is removed.
- `bh-invalid` shows `Preview unavailable` for a stored value that cannot be decoded, and preserves it.
- `bh-restore` restores the saved version's placeholder when an older version is restored.
- `bh-read-only` ignores any value a caller sends for `blurHash`.
- `bh-disabled` hides the panel and stores no new placeholder in `disabled-in-memory` mode.
- `bh-direct-upload` sends file bytes from the browser straight to S3 (`clientUploads`).

## How to get to it (user POV)

- Open `<origin>/admin/collections/media/create`, choose a file, and choose `Publish changes`.
- Open an existing document at `<origin>/admin/collections/media/<id>`.
- Read `GET /api/media/<id>` as a client.

## Driving it with the browser tool and verify.mjs

Preconditions:

- A fresh `verify launch`. The default mode generates placeholders.
- Test images live in `apps/payload-cms/tests/fixtures/images/`. Use `jpeg-baseline.jpg` for the happy path. Without a browser, upload with the `curl` example in [SKILL.md](../SKILL.md#drive).

- **Upload.** Open `<origin>/admin/collections/media/create`, set the file input `input[type="file"]` to the fixture, and choose `Publish changes`. The URL becomes `/admin/collections/media/<id>`.
- **Panel.** `[data-blurhash-panel]` appears with `canvas[data-blurhash-preview]` and the text `Generated automatically from the current image.`
- **Stored value.** `verify api GET '/api/media/<id>?depth=0'` returns a non-empty `blurHash` that matches the panel's read-only value.
- **Read-only.** `verify api PATCH '/api/media/<id>' '{"blurHash":"LKO2?U%2Tw=w]~RBVZRi};RPxuwH"}'` returns 200 and the stored `blurHash` is unchanged.
- **Disabled mode.** With `verify launch --mode disabled-in-memory`, the create view has no `[data-blurhash-panel]` and an upload stores `blurHash: null`.
- **Proof.** Screenshot the panel and save the API read.
- **Automated cover.** Unit: `pnpm --filter @codlume/payload-blurhash test:unit`. Integration (needs localstack): `pnpm --filter @codlume/payload-cms test:integration`, or one file with `pnpm --filter @codlume/payload-cms exec vitest run tests/integration/<file>.test.ts --maxWorkers=1` after `pnpm build:packages`. Admin panel and S3 upload: `pnpm --filter @codlume/payload-cms test:e2e /preview.e2e.test.ts /disabled-preview.e2e.test.ts`. Playwright reads each file argument as an unanchored regex, so the leading `/` keeps `live-preview.e2e.test.ts` out. Size and time limits: `pnpm test:limits` (Docker).

## Gotchas

- An empty value hides the whole panel, so `No BlurHash is available for this image.` is rare in practice. A failed generation never fails the upload; it stores `null` and logs a warning.
- `bh-restore` brings back the version's `blurHash` for an editor's restore through Admin or REST and for a trusted Local API restore. `tests/integration/restore-blurhash.test.ts` covers both.
- Uploads go to localstack under the run's `tests/verify-*` prefix. `verify stop` deletes that prefix.
- The state model is in `docs/statecharts/media-placeholder.md`.
