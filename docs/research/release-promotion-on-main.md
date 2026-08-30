# How single-branch projects promote prereleases to stable

Research for [#50](https://github.com/codlume/payload-toolkit/issues/50), part of the
automatic-releases map [#49](https://github.com/codlume/payload-toolkit/issues/49).
Researched 2026-08-29 from tool docs, tool source, issue trackers and real workflow files.

## Question

With only a `main` branch and nobody running workflows by hand, how do npm projects decide
when a merge becomes a prerelease (`x.y.z-next.N` on the `next` dist-tag) and when it
becomes a stable release? What is the signal, what stays automatic, and what goes wrong?

## Recommendation

"A signal carried by the merged PR" is not something any of the three tools implement as a
label or title convention. What exists:

- release-please: promotion is a config edit (`"prerelease": false`) merged like any other
  PR, or a `Release-As: x.y.z` footer in the squash-commit body. Both are signals that ride
  in a merged PR, so the owner's lean is achievable here, but the signal is "edit a JSON
  file", not "add a label".
- changesets: prerelease mode is repository state (`.changeset/pre.json`); the docs warn
  against using it on the default branch because it blocks stable releases until an exit
  commit lands. Snapshots are throwaway builds meant for testing. Neither is a per-PR
  signal. The one real repo with a label-driven prerelease (shadcn-ui) runs snapshots on
  labelled unmerged PRs with a hand-written workflow, outside the tool.
- semantic-release: channels are branches. Prereleases come only from pre-release branches,
  so a single `main` can release stable only.

Most small plugin monorepos do not run a `next` channel at all. They make every merge to
`main` a stable release (or a release-PR merge away from one) and use pkg.pr.new to give
reviewers an installable build of an unmerged PR without publishing anything to npm.

So, ranked for this repo:

1. Every merge to `main` that touches package code is a stable release. Prerelease testing
   is served by pkg.pr.new (or `changeset version --snapshot`-style throwaway builds) on
   PRs, which publishes nothing to npm and keeps no state. This is the simplest model that
   is fully automatic, and it is what Astro, Vitest, Zustand and changesets itself do for
   "try before merge".
2. If a real `next` dist-tag is required: release-please's `prerelease` versioning strategy
   with `"prerelease": true`. Every merge produces `x.y.z-next.N`; a one-line config PR
   flipping `prerelease` to `false` produces the stable. Requires release-please >= 17.2.0
   (January 2026). Known rough edges: the prerelease type cannot be advanced (alpha to beta)
   without manual intervention, the first prerelease is `-next.1` not `-next.0`, and every
   release still goes through a release PR that must be auto-merged.
3. Avoid: changesets pre mode on `main`, schedule-based stables (ships whatever is on `main`
   that day), and label-gated stables (a human still chooses, so it is not automatic and
   the label is easy to forget).

## Verified facts

### changesets

- Pre mode: `changeset pre enter <tag>` writes `.changeset/pre.json`; every later
  `changeset version` yields `x.y.z-<tag>.N` until `changeset pre exit` is committed. The
  docs: "Prereleases are very complicated!" and "If you decide to do prereleases from the
  default branch of your repository ... you will block other changes until you are ready to
  exit prerelease mode."
  ([docs/prereleases.md](https://github.com/changesets/changesets/blob/main/docs/prereleases.md))
- Snapshots: `changeset version --snapshot <tag>` then `changeset publish --tag <tag>
  --no-git-tag`; versions look like `0.0.0-<tag>-<datetime>` (or the calculated version
  with `useCalculatedVersion`). "The snapshot is intended for installation only, not to
  represent the correct published state of the repo." Refused while in pre mode.
  ([docs/snapshot-releases.md](https://github.com/changesets/changesets/blob/main/docs/snapshot-releases.md),
  [changesets#1195](https://github.com/changesets/changesets/issues/1195))
- Maintainer on per-PR prereleases: "Prerelease is an entire mode that needs to be setup and
  opt-in to work ... Snapshot releases is probably the behaviour you're looking for ...
  pkg.pr.new is also a good alternative that the core changesets repo uses."
  ([changesets/action#285](https://github.com/changesets/action/issues/285))
- The action has no hands-off mode. Publishing happens on the push created by merging the
  Version Packages PR; auto-merging that PR is unsupported, with the maintainer citing race
  conditions on quick successive merges. The version branch is always force-pushed.
  ([changesets/action#77](https://github.com/changesets/action/issues/77),
  [#215](https://github.com/changesets/action/issues/215),
  [#455](https://github.com/changesets/action/issues/455),
  [src/index.ts](https://github.com/changesets/action/blob/main/src/index.ts))
- Failure modes on record: `pre.json` carried into `main` keeps producing prereleases
  ([action#273](https://github.com/changesets/action/issues/273)); exiting pre bumps every
  package that ever had a prerelease, even with no changesets, "a necessary evil"
  ([changesets#729](https://github.com/changesets/changesets/issues/729)); `pre.json` is a
  merge-conflict magnet ([#719](https://github.com/changesets/changesets/issues/719));
  npm's publish-time malware scan delays visibility, so the "already published" probe can
  misfire ([#2195](https://github.com/changesets/changesets/issues/2195)).

### release-please

- Prerelease model: `"versioning": "prerelease"` plus `"prerelease": true` and
  `"prerelease-type": "next"` in `release-please-config.json`. The strategy bumps the last
  number of the prerelease identifier (`1.3.0-next.1`, `.2`, ...). With `prerelease: false`
  the computed bump is stripped to `major.minor.patch`, which is the promotion path; shipped
  in 17.2.0 (2026-01-20).
  ([src/versioning-strategies/prerelease.ts](https://github.com/googleapis/release-please/blob/main/src/versioning-strategies/prerelease.ts),
  [CHANGELOG 17.2.0](https://github.com/googleapis/release-please/blob/main/CHANGELOG.md),
  [PR #2516](https://github.com/googleapis/release-please/pull/2516))
- `Release-As: x.y.z` in the commit body forces a version: "When a commit to the main
  branch has `Release-As: x.x.x` (case insensitive) in the commit body, Release Please will
  open a new pull request for the specified version." Requires the squash-merge message to
  keep the PR body.
  ([README](https://github.com/googleapis/release-please#how-do-i-change-the-version-number))
- Release PR is the gate: "When you're ready to tag a release, simply merge the release PR."
  Auto-merge is user-written (`gh pr merge --squash` with retries, or `--auto` when the
  repo allows auto-merge). Because "events triggered by the `GITHUB_TOKEN` will not create
  a new workflow run", the follow-up release run needs a PAT/App token or a second
  invocation in the same job with `skip-github-pull-request: true`.
  ([release-please-action README](https://github.com/googleapis/release-please-action#readme),
  [warden-mcp workflow](https://github.com/icoretech/warden-mcp/blob/be9a73e65658990d5267e80ce55774c811caeae2/.github/workflows/release-please.yml),
  [linq-go workflow](https://github.com/linq-team/linq-go/blob/be35e885f830b17d5e751258bcd00285a9ff3cd0/.github/workflows/release-please.yml))
- GitHub Release prerelease flag: set only when `config.prerelease && (version has a
  prerelease part || major === 0)`.
  ([src/manifest.ts](https://github.com/googleapis/release-please/blob/main/src/manifest.ts))
- Publishing is not release-please's job and it never sets dist-tags; the README's example
  `npm publish` would put a `-next.1` version on `latest`. The workflow must derive `--tag`
  from the version.
  ([release-please-action README](https://github.com/googleapis/release-please-action#automating-publication-to-npm))
- Failure modes on record: prerelease type cannot be changed or reset once in use
  ([#2447](https://github.com/googleapis/release-please/issues/2447)); first prerelease
  lacks `.0` ([#2467](https://github.com/googleapis/release-please/issues/2467)); concurrent
  merges of separate release PRs collide
  ([#2746](https://github.com/googleapis/release-please/issues/2746)); `prerelease`,
  `prerelease-type` and `versioning` are config-file only, not action inputs
  ([action#1101](https://github.com/googleapis/release-please-action/issues/1101)).

### semantic-release

- "A branch can be defined as one of three types: release, maintenance, pre-release."
  Channels map to branches: "By default releases will be done on the default distribution
  channel (for example the @latest dist-tag for npm) for the first release branch and on a
  distribution channel named based on the branch name for any other branch." Prerelease
  versions come only from pre-release branches. A single `main` therefore releases stable
  on every push and cannot produce a `next` channel.
  ([workflow configuration](https://semantic-release.gitbook.io/semantic-release/usage/workflow-configuration))
- No `0.x` semantics by design; see the 0.x research.

### Real repos, single branch or not

| Repo | Tool | Stable trigger | Prerelease trigger | Human step |
|---|---|---|---|---|
| sveltejs/kit | changesets/action v2 | push to `main` | none | merges Version Packages PR |
| shadcn-ui/ui | changesets/action | push to `main` | label `release: beta` or `release: rc` on an open PR runs a snapshot from the PR head | merges Version Packages PR |
| emotion-js/emotion | changesets/action | push to `main` | push to `next` branch in pre mode | merges Version Packages PR |
| withastro/astro | changesets/action | push to `main` | branch-based; PR previews via pkg.pr.new on label `pr preview` | merges Version Packages PR |
| TanStack/query | changesets/action | push to `main` | branch names `*-pre`, `*-maint`, `v[0-9]` | merges Version Packages PR |
| trpc/trpc | lerna | `workflow_dispatch` with `dist_tag=latest` | every push to `main` touching `packages/**` publishes `canary` | dispatches stable |
| payloadcms/payload | custom releaser | tag push (v4 line), maintainer-run script (v3) | `workflow_dispatch` publishes `canary`/`internal` | dispatches |
| vitest-dev/vitest | bumpp + changelogithub | `chore: release vX` commit on `main` | pkg.pr.new on PRs | merges release PR |
| pmndrs/zustand | none | manual GitHub Release | pkg.pr.new on push and PRs | creates release |

Sources: each repo's `.github/workflows/release.yml` or equivalent, fetched raw.

None of these derives "stable or prerelease" from a label on a merged PR. The two projects
with an automatic prerelease channel (trpc canary, Payload canary) make stable a manual
step; the projects with automatic stable make prerelease a branch or skip it.

### pkg.pr.new

Used by Astro, Vitest, Zustand and the changesets repo: a GitHub App publishes each PR (or
push) build to its own registry URL (`npm i https://pkg.pr.new/<owner>/<repo>/<pkg>@<sha>`),
so reviewers can install a change without any npm version, dist-tag or git state.
([Astro preview-release.yml](https://github.com/withastro/astro/blob/main/.github/workflows/preview-release.yml),
[Vitest cr.yml](https://github.com/vitest-dev/vitest/blob/main/.github/workflows/cr.yml),
[Zustand preview-release.yml](https://github.com/pmndrs/zustand/blob/main/.github/workflows/preview-release.yml))

## What this means for the decision ticket (#54)

- Decide first whether a `next` dist-tag is a requirement or whether "try a PR before it
  merges" is the real need. If the latter, pkg.pr.new and stable-on-every-merge is the
  smallest fully automatic model.
- If `next` is required, release-please is the only tool where a single `main` can produce
  prereleases and promote them through a merged PR, and the promotion is a config flip.
- Whatever the model, publishing prereleases needs `--tag next` derived from the version;
  no tool does this for you.

## Not verified

- The exact `gh pr merge --auto` behaviour when the repository's "Allow auto-merge" setting
  is off (one repo reports a "clean status" error and falls back to `--admin`).
- Whether any release-please user maps `-next.` versions to `--tag next` in a public
  workflow; only a `latest` vs `major-N` mapping was found (kolatts/pncli).
