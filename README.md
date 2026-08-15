# Payload Toolkit

Payload Toolkit is a collection of independently released plugins for
[Payload CMS](https://payloadcms.com/). This repository provides the shared
workspace where those plugins and the applications that exercise them will be
developed.

The workspace is intentionally project-free while its foundation is being
established. It does not yet contain a runnable application or a publishable
package.

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

- `packages/` is reserved for independently released Payload plugins and for
  internal libraries only after multiple plugins need shared implementation.
- `apps/` is reserved for non-published Payload CMS applications that
  demonstrate plugins or exercise integration and end-to-end behavior.

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
`package.json` script. Projects without that script are skipped, so the
intentionally project-free workspace succeeds without placeholder tests.

Future TypeScript projects should extend the strict root
`tsconfig.base.json` baseline.
