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
