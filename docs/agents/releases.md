# Releases

Release planning is automatic, and each Payload plugin keeps its own version.
A maintainer chooses when to publish by merging the Release pull request. Never
publish a package manually.

## Pull request titles

The squash commit title comes from the pull request title, and release-please
uses it to choose the version bump. CI requires this pattern:

```text
^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([^()]+\))?!?: \S.*$
```

For example, `fix(payload-blurhash): preserve the source aspect ratio` is a
fix. Add `!` before the colon for a Breaking change, as in
`feat(payload-activity)!: rename the attribution field`.

Release-please titles the grouped Release pull request
`chore(release): prepare plugin releases from main`. The `${branch}` placeholder
names the Release pull request's base branch, regardless of how many feature
pull requests or plugins it contains. Keep that recognized placeholder so
release-please can parse the title after merge.

Release-please refreshes only the body of an open Release pull request, never
its title. After changing `group-pull-request-title-pattern`, retitle the open
Release pull request by hand to match the new pattern. A merged Release pull
request whose title does not match fails its Release run with
`Bad pull request title` before anything reaches npm; retitle the merged pull
request, then re-run the failed jobs.

A Releasable merge is a merge to `main` that changes a plugin and has a
`feat`, `fix`, `perf`, `refactor`, or `revert` title, or any accepted title
marked with `!`. While a plugin is on `0.x`, a Breaking change bumps the minor
version and other Releasable merges bump the patch version. Changes such as
documentation, tests, and tooling ride along with that plugin's next Release
instead of starting one.

## What the Release run does

After each merge to `main`, the Release run asks release-please whether a plugin
has releasable changes. If so, release-please opens or updates one release pull
request for the affected plugins. Further merges accumulate in that Release pull
request. Nothing is published yet.

To choose a release boundary:

1. Merge every feature pull request that should ship.
2. Wait for the newest Release run to update the Release pull request from
   `main`.
3. Review its versions and changelog entries. If another feature pull request
   reaches `main`, wait for the next update and review it again.
4. Merge the Release pull request without merging another feature pull request
   at the same time.

The merge authorizes publication and starts another Release run. It checks out
the release pull request's merge commit, builds and tests it, and creates each
changed plugin's git tag and GitHub Release from the matching changelog entry.
Publishing to npm through trusted publishing is the last step, so a GitHub
Release can appear a minute or two before its version installs. If GitHub
replaces that pending run, a later Release run finishes the already-authorized
release. No run can publish without a merged Release pull request.

A Release is one plugin's npm version, git tag, GitHub Release, and
`CHANGELOG.md` entry. Plugins have independent versions, so releasing one says
nothing about the other.

Never edit a plugin's `CHANGELOG.md` or version by hand. Do not edit
`.release-please-manifest.json` by hand either. Release-please owns all three.

## Contributor attribution

After release-please creates or refreshes the pending Release pull request,
Release pull request preparation adds contributor mentions to its generated
changelog entries. Every step of the Release run that is not a third-party
action is a command of `tools/release-tools`, the Workspace tool that holds
the release automation. A change from a merged pull request ends with `by @login`
when its author is a human GitHub user. The same entry becomes the plugin's
GitHub Release body after approval, so GitHub renders its native Contributors
avatar panel.

The Release pull request stays in draft while the workflow resolves authors and
updates its changelogs and body. The workflow verifies that the pull request
still points at the exact prepared commit before and after marking it ready for
review. If the head moves during the final readiness change, the workflow moves
the pull request back to draft and fails. Any failed or stale run is safe to
retry.

Attribution follows each plugin's Release boundary. If one pull request ships
in more than one plugin, each applicable Release credits its author. Bot pull
request authors are excluded. Commit authors and co-authors, including Claude
trailers, are not considered. Direct commits and pull requests whose author
account no longer resolves stay unattributed; the workflow warns and continues.

GitHub contributor lookups must succeed before Release pull request preparation
completes. An API failure stops the run before maintainer approval, and re-running
the failed jobs retries the enrichment. This step changes only the generated
release-note text in the changelog files and Release pull request body.
Release-please still decides release eligibility, versions, and which changes the
pending Release pull request contains. Merging that pull request remains the only
publication approval.

## Preview builds

A pull request that touches `packages/**` publishes installable Preview builds
through pkg.pr.new. Its GitHub App comments the install commands on the pull
request. A Preview build has no npm version, git tag, GitHub Release, or
changelog entry.

## Recovering a failed Release run

Use "Re-run failed jobs" on the failed workflow run. The Release run checks
which work already completed and resumes from GitHub and npm state. There is no
`workflow_dispatch` entry point. Merging the Release pull request is the only
approval step; never publish directly from a local checkout.

A merged Release pull request labeled `autorelease: pending` still needs its
GitHub Releases and its npm publish. Release-please relabels it
`autorelease: tagged` when the GitHub Releases exist, before npm publish runs.
From then on only a re-run publishes the versions npm still lacks; an ordinary
push after a finished release leaves it alone.

Two retries need another pass:

- npm can take a couple of minutes to make a published version visible. A
  retry during that window may try to publish the same version and fail. Wait a
  couple of minutes, then use "Re-run failed jobs" again.
- If every GitHub Release exists but release-please failed before relabeling
  the release pull request, the next run relabels it and may fail once more.
  Re-run the failed jobs again; the following run finds nothing left to do.

A release commit that fails its own build becomes a Skipped version. It keeps
its changelog entry, git tag, and GitHub Release, but the workflow never
publishes that version to npm. Fix the problem in a new pull request; the fix
ships as the next version.

## Reaching 1.0.0

`1.0.0` is always explicit. Put a `Release-As: 1.0.0` footer in the pull
request body so the squash commit carries the override. Do not set the plugin
version or release-please manifest yourself.
