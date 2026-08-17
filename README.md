# Payload Toolkit

Payload Toolkit is a collection of independently released plugins for
[Payload CMS](https://payloadcms.com/). This repository provides the shared
workspace where those plugins and the applications that exercise them will be
developed.

The workspace currently contains the first private plugin slice and the private
Payload application that exercises it. Both remain unreleased while the full
BlurHash contract and distribution checks are completed.

## Prerequisites

- Node.js 24.13.1
- Corepack, included with the pinned Node.js release
- Docker with Compose, for the S3 integration and browser tests

The repository pins pnpm 11.10.0 through its root package manifest. Enable the
Corepack shim, then install the committed dependency graph:

```sh
corepack enable
pnpm install --frozen-lockfile
```

## Workspace layout

- `packages/payload-blurhash/` contains the private
  `@codlume/payload-blurhash` plugin.
- `apps/payload-cms/` contains the private SQLite-backed Payload application
  used to exercise the plugin through real Payload APIs.
- Additional projects may join `packages/` or `apps/`; internal libraries are
  introduced only after multiple plugins need shared implementation.

Only direct child projects of these two containers join the pnpm workspace.

## Validation

Start the pinned LocalStack S3 service before running integration, end-to-end,
or full readiness checks. The same checked-in Compose service is used locally
and in CI:

```sh
pnpm services:up
pnpm ready
pnpm services:down
```

LocalStack listens at `http://127.0.0.1:4566`, creates the
`payload-blurhash` bucket, and applies browser `PUT` CORS rules. Automated runs
use unique database and upload directories plus object prefixes under `tests/`;
their cleanup only deletes the prefix owned by that run.

- `pnpm fmt` formats supported files and sorts package manifests.
- `pnpm fmt:check` checks formatting without changing files.
- `pnpm lint` runs the shared type-aware Vite+ lint policy.
- `pnpm typecheck` runs Vite+'s integrated TypeScript checker.
- `pnpm test:unit` runs unit-test scripts across the workspace.
- `pnpm test:integration` runs integration-test scripts across the workspace.
- `pnpm test:e2e` runs end-to-end-test scripts across the workspace.
- `pnpm ready` runs every non-mutating validation command above and is the
  authoritative local readiness check.

The test commands discover participating projects by their corresponding
`package.json` script. Projects without that script are skipped.

## Payload application modes and storage

`apps/payload-cms` selects one immutable startup mode with `PAYLOAD_APP_MODE`:

- `enabled-in-memory` enables generation with ordinary in-memory multipart
  handling and is the default.
- `enabled-temporary-file` enables generation while Payload streams multipart
  uploads through an owned temporary-file directory.
- `disabled-in-memory` keeps the stored field and stale-value lifecycle while
  generation and its Admin field are disabled.

The application uses Payload's official S3 adapter with browser-direct uploads.
Its local defaults target the checked-in LocalStack service. A deployment can
select any supported S3-compatible endpoint, including Cloudflare R2, through
environment configuration:

- `PAYLOAD_S3_ENDPOINT` (R2:
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`)
- `PAYLOAD_S3_REGION` (R2: `auto`)
- `PAYLOAD_S3_ACCESS_KEY_ID` and `PAYLOAD_S3_SECRET_ACCESS_KEY`
- `PAYLOAD_S3_BUCKET`
- `PAYLOAD_S3_FORCE_PATH_STYLE` (`false` disables the default path-style mode)
- `PAYLOAD_S3_PREFIX` to isolate the application's object keys

R2 credentials, accounts, and hosted smoke tests are not required by this
repository. The deployment bucket must allow browser `PUT` requests from the
deployed Admin origin.

Future TypeScript projects should extend the strict root
`tsconfig.base.json` baseline.

Installing dependencies configures a pre-commit hook that runs the shared
formatter on supported staged files and stages its updates automatically. The
hook does not run the slower linting, type-checking, or test commands. Run
`pnpm fmt` directly whenever you want to format the whole workspace.
