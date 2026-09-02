# @codlume/release-tools

Release automation for Payload Toolkit. A Workspace tool: never published and
never imported by a Payload plugin.

The Release workflow runs it from a fresh checkout with bare Node, so the
sources have no runtime dependencies and no build step. Node strips the types
at load time; keep the code within erasable TypeScript syntax and use `.ts`
extensions on relative imports.

```sh
node tools/release-tools/src/cli.ts prepare-pull-request
```

Commands:

- `prepare-pull-request` performs Release pull request preparation: it credits
  contributors in the draft Release pull request's changelogs and body, verifies
  the pull request still points at the prepared commit, and marks it ready for
  review. Reads `GITHUB_REPOSITORY` and `GH_TOKEN` or `GITHUB_TOKEN`.

Tests run with the rest of the workspace through `pnpm test:unit`. See
`docs/agents/releases.md` for how the Release run fits together.
