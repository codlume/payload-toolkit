# @codlume/release-tools

Release automation for Payload Toolkit. A Workspace tool: never published and
never imported by a Payload plugin.

The Release workflow runs it from a fresh checkout with bare Node, so the
sources have no runtime dependencies and no build step. Node strips the types
at load time; keep the code within erasable TypeScript syntax and use `.ts`
extensions on relative imports.

```sh
node tools/release-tools/src/cli.ts <command>
```

Commands, in the order the Release run uses them. All but `publish` read
`GITHUB_REPOSITORY` and `GH_TOKEN` or `GITHUB_TOKEN`.

- `hold-draft` moves an open Release pull request back to draft before
  release-please refreshes it.
- `find-release-commit` names the merge commit the rest of the run may act on
  and appends `number`, `sha`, and `pending` to `GITHUB_OUTPUT`. Reads
  `GITHUB_RUN_ATTEMPT` to let a re-run finish a tagged release.
- `prepare-pull-request` performs Release pull request preparation: it credits
  contributors in the draft Release pull request's changelogs and body, verifies
  the pull request still points at the prepared commit, and marks it ready for
  review.
- `verify-tagged` fails unless the merged Release pull request in `RELEASE_PR`
  carries the `autorelease: tagged` label.
- `publish` runs pnpm's recursive publish for each `packages/*` entry of the
  current directory, one at a time, and fails at the end if any failed.

Tests run with the rest of the workspace through `pnpm test:unit`. See
`docs/agents/releases.md` for how the Release run fits together.
