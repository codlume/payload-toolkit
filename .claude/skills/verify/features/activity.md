# Last Modified By attribution

`@codlume/payload-activity` records which admin user last changed a document. The demo app enables it on the `media` collection and the `site-settings` global, where it shows as the read-only sidebar field `Last Modified By`.

## Sub-features

- `act-create` records the admin who creates a document, including duplicates.
- `act-update` records the admin who saves, saves a draft, or autosaves.
- `act-clear` clears the value when a write has no admin user, such as a script without `user`.
- `act-global-restore` records the admin who restores a global version, without rewriting older versions. The demo Site Settings global has no versions, so only the package integration suite covers this.
- `act-read-only` ignores any value a caller sends for `lastModifiedBy`.
- `act-disabled` hides the field and keeps the stored value on update when the plugin is disabled. The demo app always installs the plugin, so only the package tests cover this.

## How to get to it (user POV)

- Upload or edit media at `<origin>/admin/collections/media/<id>` and read the sidebar.
- Save `Site Name` at `<origin>/admin/globals/site-settings`.
- Read `lastModifiedBy` from `GET /api/media/<id>?depth=0` or `GET /api/globals/site-settings?depth=0`.

## Driving it with the browser tool and verify.mjs

Preconditions:

- A fresh `verify launch` and a signed-in tab. The seeded admin has id `1`.

- **Global update.** Open `<origin>/admin/globals/site-settings`, type `Verify site` into `Site Name`, and save. The sidebar `Last Modified By` shows `Verify Admin`.
- **Stored value.** `verify api GET '/api/globals/site-settings?depth=0'` returns `lastModifiedBy: 1`.
- **Media.** Upload a file as in [blurhash.md](./blurhash.md). `verify api GET '/api/media/<id>?depth=0'` returns `lastModifiedBy: 1`.
- **Read-only.** `verify api PATCH '/api/media/<id>' '{"lastModifiedBy":999}'` returns 200 and the stored value stays `1`.
- **Global restore.** No app surface. Run `pnpm --filter @codlume/payload-activity exec vitest run tests/integration/global-restore.test.ts --maxWorkers=1` after `pnpm build:packages`. The test turns on versions for its own global.
- **Proof.** Screenshot the sidebar field and save the API reads.
- **Automated cover.** Unit: `pnpm --filter @codlume/payload-activity test:unit`. Package integration (restore, disabled duplicates, admin collection default): `pnpm --filter @codlume/payload-activity test:integration`. App integration: `pnpm --filter @codlume/payload-cms exec vitest run tests/integration/activity-attribution.test.ts --maxWorkers=1` after `pnpm build:packages`, with localstack up.

## Gotchas

- With `--test-context`, Site Settings becomes the localized test global with a different shape. Use the default launch for this recipe.
- Local API writes without `user` clear the attribution by design. A seed script that omits `user` erases it.
- The state model is in `docs/statecharts/media-placeholder.md`, which models attribution next to the placeholder.
