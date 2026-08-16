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

Future TypeScript projects should extend the strict root
`tsconfig.base.json` baseline.

Installing dependencies configures a pre-commit hook that runs the shared
formatter on supported staged files and stages its updates automatically. The
hook does not run the slower linting, type-checking, or test commands. Run
`pnpm fmt` directly whenever you want to format the whole workspace.
