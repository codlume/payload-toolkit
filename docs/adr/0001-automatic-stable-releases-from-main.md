# Automatic stable releases from main, no prerelease channel

Both plugins are `0.x` and live in one repo with squash-only merges and conventional PR titles. We release each plugin independently with release-please in manifest mode: every releasable merge to `main` produces a stable release, a breaking change (`!` in the PR title) bumps the minor while on `0.x`, and `1.0.0` needs an explicit `release-as` override. There is no `next` dist-tag. Pull requests get preview builds from pkg.pr.new instead, because no tool can promote a prerelease from a signal on a merged PR, and on `0.x` a prerelease channel adds little that a patch bump does not.

## Considered options

- Hand-rolled tag-as-truth workflow. Fewer moving parts and GitHub's own "What's Changed" notes, but we wanted a `CHANGELOG.md` in each package and did not want to own bump logic and the `0.x` clamp.
- changesets. Needs a changeset file per PR and its prerelease mode is warned against on the default branch.
- semantic-release. Channels are branches and it refuses `0.x` semantics.

## Consequences

- The release workflow merges its own release PR with `GITHUB_TOKEN` and runs release-please a second time in the same job to tag and publish. That commit never runs Validate; it only touches `CHANGELOG.md`, `package.json` and `.release-please-manifest.json`. Chosen over a GitHub App token to avoid a key to rotate and a ruleset to maintain.
- Release bodies come from the changelog entry, so they carry the PR link but not the author name.
- GitHub's single "Latest" badge follows whichever plugin released most recently.
- PR titles are enforced in CI and the squash title setting must be `PR_TITLE`, because bumps are derived from them.
