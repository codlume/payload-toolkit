# Payload Toolkit

Payload Toolkit develops two independently released plugins for
[Payload CMS](https://payloadcms.com/):
[`@codlume/payload-activity`](packages/payload-activity/) records who last
edited configured collections and globals, and
[`@codlume/payload-blurhash`](packages/payload-blurhash/) generates BlurHash
placeholders for uploaded images. Both plugins are published to npm. This
repository is their shared workspace and contains the application that
exercises them.

## Prerequisites

- Node.js 24.13.1
- Corepack, included with the pinned Node.js release
- Docker with Compose, for the S3 integration and browser tests

The repository pins pnpm 11.10.0 through its root package manifest. Enable the
Corepack shim, then install the committed dependency graph:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm browsers:install
```

## Workspace layout

- `packages/payload-activity/` contains the `@codlume/payload-activity` plugin.
- `packages/payload-blurhash/` contains the `@codlume/payload-blurhash` plugin.
- `apps/payload-cms/` contains the private SQLite-backed Payload application
  used to exercise the plugin through real Payload APIs.
- Additional projects may join `packages/` or `apps/`; internal libraries are
  introduced only after multiple plugins need shared implementation.

Only direct child projects of these two containers join the pnpm workspace.

## Releases

A Releasable merge changes a plugin on `main` through a feature, fix,
performance improvement, revert, or Breaking change. Mark a Breaking change
with `!` in the pull request title; while a plugin is on `0.x`, this bumps its
minor version. Other releasable changes bump the patch version.

Releasable merges accumulate in a Release pull request instead of publishing
immediately. After the latest Release run updates that pull request, a
maintainer reviews its versions and changelog entries, then merges it to
authorize publication.

Each plugin has independent Releases. A Release consists of an npm version, a
git tag, a GitHub Release, and an entry in that plugin's `CHANGELOG.md`. Pull
requests that touch `packages/**` receive a comment with install commands for
their Preview builds. Agents and maintainers should follow
[the release guide](docs/agents/releases.md), including its recovery steps,
instead of publishing a package manually.

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
- `pnpm browsers:install` installs the pinned Playwright Chromium build required
  by end-to-end tests. CI adds `--with-deps` for clean Linux runners.
- `pnpm typecheck` runs Vite+'s integrated TypeScript checker.
- `pnpm test:unit` runs unit-test scripts across the workspace.
- `pnpm test:integration` runs integration-test scripts across the workspace.
- `pnpm test:e2e` runs end-to-end-test scripts across the workspace.
- `pnpm test:build` checks package entry-point isolation, generated Payload
  artifacts, and the workspace application's production build.
- `pnpm test:pack` inspects the real package tarball and installs it in a clean
  current-lane consumer without workspace hoisting.
- `pnpm test:compat` builds isolated Linux consumers for the minimum Node
  22.12.0 and current Node 24.13.1 lanes. Each installs the real plugin tarball
  with Payload 3.88.0 and the exact host dependency pins, then exercises the
  shared application source through configuration, lifecycle, decoder, S3,
  generated-artifact, type, and production-build checks. Pass `minimum` or
  `current` to run one lane, such as `pnpm test:compat minimum`.
- `pnpm test:limits` builds a controlled Linux image, caps it at 2 vCPU and
  2 GiB, and records the BlurHash resource-limit evidence described below.
- `pnpm ready` is the authoritative current-lane readiness check. It runs
  formatting checks, linting, type-checking, unit, integration, end-to-end,
  build/generated-artifact, and pack checks without rewriting source files.
  Compatibility lanes and controlled resource measurements remain explicit
  commands because they use isolated or hardware-bounded Docker environments.

Pull requests and default-branch pushes run `pnpm ready` against the pinned
LocalStack service and run `pnpm test:compat minimum` in a parallel job. CI and
local development therefore use the same root commands.

The test commands discover participating projects by their corresponding
`package.json` script. Projects without that script are skipped.

### Resource-limit evidence

`pnpm test:limits` checks the default 25 MiB compressed-byte, 40-million-pixel,
16,384-pixel-side, ten-second timeout, and concurrency-two boundaries. It then
runs one warm-up and five recorded executions for each successful boundary
workload, including two concurrent inputs that each combine the 40-million-pixel
and 25 MiB limits. Successful work must finish within five seconds, two
concurrent generations must stay below 1.5 GiB of total process memory, and the
plugin queue must never observe more than two active generations.

The gate writes `artifacts/limits/blurhash-limits.json` with decode, queue, and
total durations, outcome codes, input sizes, dimensions, and peak memory. Its
large fixtures are generated in an owned temporary directory inside the
container and removed whether the gate succeeds or fails. The evidence
directory is ignored by Git and can be uploaded by CI without changing the
working tree. This controlled gate is intentionally separate from ordinary
local readiness.

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
