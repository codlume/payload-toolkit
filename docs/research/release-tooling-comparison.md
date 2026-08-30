# Release tooling fit for main-only automatic releases

Research for [#52](https://github.com/codlume/payload-toolkit/issues/52), part of the
automatic-releases map [#49](https://github.com/codlume/payload-toolkit/issues/49).
Researched 2026-08-29 from tool docs and source, GitHub and npm docs, and real workflows.
Companion notes: [prerelease promotion](./release-promotion-on-main.md),
[independent vs lockstep](./independent-vs-lockstep-versioning.md),
[0.x bumps](./zero-x-breaking-changes.md).

## Question

Which fits best: release-please, changesets, semantic-release, or a hand-rolled GitHub
Actions workflow? Constraints: pnpm monorepo, two public packages, `main` only, nobody runs
anything by hand, bump derived from conventional PR titles, stable plus prerelease, a
GitHub Release per release, a `CHANGELOG.md` per package, npm trusted publishing (OIDC)
with provenance, Node 24 / pnpm 11.

## Recommendation

1. release-please (manifest mode). It is the only candidate that meets every constraint
   without a second branch or hand-written files: bumps from conventional commit titles,
   independent versions with per-package `CHANGELOG.md`, one GitHub Release per package,
   a documented `0.x` clamp, and a prerelease strategy that works on one branch. Two things
   must be added by hand: an auto-merge step for the release PR (with a token that can
   trigger workflows, or a second in-job invocation), and a publish job that runs
   `pnpm publish` with OIDC and picks `--tag next` for prerelease versions.
2. Hand-rolled workflow. Fits if per-package `CHANGELOG.md` is dropped: tag as the source of
   truth, `gh release create --generate-notes` for the exact "What's Changed" look, no bot
   commits on `main`. Costs: writing and owning the bump logic, `0.x` clamp, idempotent
   re-runs and per-package tag ranges yourself. Payload, trpc and payload-enchants all
   ended up here, and all of them kept a manual step for stable.
3. changesets. Excellent monorepo and changelog support, and `@changesets/changelog-github`
   produces the closest match to "What's Changed" (`Thanks @author! - text (#123)`). But it
   needs a `.changeset/*.md` file per PR (not PR-title driven), the Version Packages PR is
   designed to be merged by a human, and prereleases on `main` are warned against.
   Choose it only if writing changeset files is acceptable.
4. semantic-release. Fully automatic by design, but channels are branches (no prerelease
   from `main`), `0.x` is refused on purpose, monorepo support is a third-party fork that
   describes itself as "hacky" and is in maintenance mode, and per-package changelogs need
   extra plugins that commit back to `main`.

## Comparison

| Constraint | release-please | changesets | semantic-release | hand-rolled |
|---|---|---|---|---|
| Bump from conventional PR titles | Yes (squash merge) | No; needs a changeset file per PR | Yes | Yes, write it |
| Nobody runs anything | Release PR must be merged; auto-merge is a user step | Version Packages PR is human-merged by design; auto-merge unsupported | Yes | Yes |
| Where the version lives | Committed: release PR updates `package.json`, `CHANGELOG.md`, `.release-please-manifest.json` | Committed by the Version Packages PR | Not committed by default (`0.0.0-development` placeholder; `@semantic-release/git` can commit) | Either; tag-as-truth avoids bot commits |
| Independent versions, two packages | Manifest with two paths; `separate-pull-requests: false` recommended (concurrent PR merges collide) | Native | Only via multi-semantic-release / semantic-release-monorepo | Write it |
| Per-package `CHANGELOG.md` | Yes | Yes | Plugin per package, commits back | Write it or skip |
| GitHub Release per package | Yes | Yes (default `create-github-releases`) | Yes (`@semantic-release/github`) | `gh release create` |
| Release body | Own changelog: grouped by type, PR and commit links, no `@author`; or `changelog-type: github` to use GitHub's generated notes | Changelog entry; with changelog-github: `Thanks @author! - text (#123)` | conventional-changelog format | GitHub's generated notes, exact match |
| Prerelease on a single branch | `versioning: prerelease` + `prerelease: true`; promote by config flip or `Release-As:` | Pre mode (warned against on default branch) or throwaway snapshots | No; pre-release branches only | Write it |
| `0.x` breaking = minor | `bump-minor-pre-major`, `bump-patch-for-minor-pre-major` | No | No, by design | Write it |
| npm publish + OIDC + dist-tag | Not its job; publish step gated on `release_created`; must derive `--tag` | `changeset publish` uses npm, idempotent, `--tag` flag | `@semantic-release/npm` sets channel dist-tag | `pnpm publish --tag` |
| Trigger | push to `main` (plus release PR merge) | push to `main` | push to `main` | push with `paths` filter |
| Known pain | GITHUB_TOKEN merges do not retrigger; prerelease-type stuck; races with separate PRs; config keys missing as action inputs | force-push of version branch; pre.json conflicts; npm visibility delay breaks "already published" probe; snapshots refused in pre mode | monorepo fork maintenance; no 0.x | you own every edge case |

## Verified facts

### release-please

- Manifest mode: `release-please-config.json` with a `packages` map and
  `.release-please-manifest.json` holding current versions ("must exist at the tip of the
  target branch"; may be empty on first run). `release-type: node` updates `package.json`
  and `CHANGELOG.md`. `separate-pull-requests` defaults to `false` for more than one
  package; concurrent merges of separate release PRs are a known open race.
  ([manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md),
  [#2746](https://github.com/googleapis/release-please/issues/2746))
- Tags default to `<component>-v<version>` with the npm scope stripped
  (`payload-blurhash-v0.4.0`); `include-component-in-tag: false` gives plain `vX.Y.Z`.
  ([src/strategies/node.ts](https://github.com/googleapis/release-please/blob/main/src/strategies/node.ts))
- Release flow: "When the Release PR is merged, release-please ... Updates your changelog
  file ... Tags the commit with the version number ... Creates a GitHub Release based on the
  tag." Both squash and merge commits work.
  ([README](https://github.com/googleapis/release-please#readme))
- Changelog types: `default` ("Groups by commit type and links to pull requests and
  commits") or `github` ("Uses the GitHub API to generate notes"), config key
  `changelog-type`.
  ([customizing.md](https://github.com/googleapis/release-please/blob/main/docs/customizing.md))
- Action outputs per path (`packages/x--release_created`, `--tag_name`, `--version`) and
  `paths_released` gate the publish job. "When you use the repository's `GITHUB_TOKEN` to
  perform tasks, events triggered by the `GITHUB_TOKEN` will not create a new workflow run."
  ([release-please-action README](https://github.com/googleapis/release-please-action#readme))
- Auto-merge patterns in the wild: `gh pr merge --squash` with retries then a second action
  invocation with `skip-github-pull-request: true` in the same job (icoretech/warden-mcp);
  `gh pr merge --auto` (kolatts/pncli); `--squash || --squash --admin` (linq-team/linq-go).
  ([warden-mcp](https://github.com/icoretech/warden-mcp/blob/be9a73e65658990d5267e80ce55774c811caeae2/.github/workflows/release-please.yml),
  [pncli](https://github.com/kolatts/pncli/blob/94b7d3f0a8538938548eed242522a07df7d34000/.github/workflows/release-please.yml),
  [linq-go](https://github.com/linq-team/linq-go/blob/be35e885f830b17d5e751258bcd00285a9ff3cd0/.github/workflows/release-please.yml))
- Action v5 (2026-04) bundles release-please 17.6.x and runs on Node 24.
  ([releases](https://github.com/googleapis/release-please-action/releases))

### changesets

- Each change needs a `.changeset/*.md` file naming packages and bump type; the action
  opens a Version Packages PR when changesets exist and publishes when none remain.
  ([changesets/action src/index.ts](https://github.com/changesets/action/blob/main/src/index.ts))
- Action v2 (Changesets v3) inputs: `publish-script`, `version-script`,
  `create-github-releases`, `push-git-tags`, etc.; requires `contents: write`,
  `pull-requests: write` and the repo setting "Allow GitHub Actions to create and approve
  pull requests". The version branch is force-pushed; a non-force option was declined.
  ([README](https://github.com/changesets/action#readme),
  [#455](https://github.com/changesets/action/issues/455))
- Auto-merge of the Version Packages PR is not built in; maintainer objects on race grounds.
  ([#77](https://github.com/changesets/action/issues/77),
  [#215](https://github.com/changesets/action/issues/215))
- `changeset publish` checks npm for each package version before publishing, so re-runs are
  safe, except that npm's publish-time scan delays visibility and can fool the probe.
  ([command-line-options.md](https://github.com/changesets/changesets/blob/main/docs/command-line-options.md),
  [#2195](https://github.com/changesets/changesets/issues/2195))
- Prerelease and snapshot behaviour: see the promotion research.

### semantic-release

- Branch types release / maintenance / pre-release; "By default releases will be done on
  the default distribution channel (for example the @latest dist-tag for npm) for the first
  release branch and on a distribution channel named based on the branch name for any other
  branch."
  ([workflow configuration](https://semantic-release.gitbook.io/semantic-release/usage/workflow-configuration))
- `0.x` refused: "Semantic Versioning rules apply differently to major version zero and
  supporting those differences is out of scope."
  ([FAQ](https://semantic-release.gitbook.io/semantic-release/support/faq#can-i-set-the-initial-release-version-of-my-package-to-0-0-1))
- Monorepo: `@qiwi/multi-semantic-release` describes itself as "hacky semantic-release for
  monorepos" and says its maintainers are "gradually migrating to bulk-release" and develop
  it "on a leftover basis". Tags default to `${name}@${version}`.
  ([README](https://github.com/qiwi/multi-semantic-release#readme))

### Hand-rolled examples

- Payload: custom `tools/releaser` (changelogen for notes), lockstep versions, v3 stable via
  a maintainer-run script, v4 canary via `workflow_dispatch` bump plus tag-push publish with
  `NPM_CONFIG_PROVENANCE: true` and `id-token: write`. Not automatic on merge.
  ([release-bump.yml](https://github.com/payloadcms/payload/blob/main/.github/workflows/release-bump.yml),
  [publish-release.yml](https://github.com/payloadcms/payload/blob/main/.github/workflows/publish-release.yml))
- trpc: lerna canary on every push to `main` touching `packages/**`; stable by dispatch.
  ([release-manual.yml](https://github.com/trpc/trpc/blob/main/.github/workflows/release-manual.yml))
- Vitest: bumpp release PR, publish on `chore: release vX` commit, notes via changelogithub
  (`* text - by @user in #PR`, avatars, compare link).
  ([publish.yml](https://github.com/vitest-dev/vitest/blob/main/.github/workflows/publish.yml))
- payload-enchants: hand bump script, manual GitHub Release with generated notes, publish
  workflow commented out.
  ([bump-version.ts](https://github.com/r1tsuu/payload-enchants/blob/master/scripts/bump-version.ts))

### GitHub and npm facts that shape any choice

- Generated release notes are per tag range, filterable by label and author only; the
  `generate-notes` API accepts `previous_tag_name` and `configuration_file_path`;
  `gh release create --generate-notes --notes-start-tag` exposes the same.
  ([docs](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes),
  [REST](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release))
- One "Latest" per repository; prereleases can never be Latest; `make_latest` controls it.
  ([REST create release](https://docs.github.com/en/rest/releases/releases#create-a-release))
- Trusted publishing: npm CLI >= 11.5.1, Node >= 22.14, `id-token: write`, the workflow
  filename configured on npmjs.com must match exactly, provenance is generated
  automatically, and the package must already exist to attach a trusted publisher.
  `package.json.repository` must match the repo for provenance.
  ([trusted publishers](https://docs.npmjs.com/trusted-publishers),
  [provenance](https://docs.npmjs.com/generating-provenance-statements))
- `npm publish` defaults to the `latest` dist-tag; prerelease versions need `--tag`.
  ([npm publish](https://docs.npmjs.com/cli/v10/commands/npm-publish))

## What this means for the decision ticket (#54)

- If per-package `CHANGELOG.md` stays a requirement, choose release-please and accept bot
  release commits on `main` and an auto-merge step.
- If the changelog can live only in GitHub Releases, a hand-rolled tag-as-truth workflow is
  smaller and gives the exact "What's Changed" look, at the price of owning the logic.
- Either way the publish step is yours: `pnpm -r publish` with OIDC, `--tag next` for
  versions containing `-`, gated on what was released.
- Decide whether the release job needs `concurrency` (yes, one group for the workflow) and
  what a re-run does after a partial failure; release-please's tag-then-release order and
  `changeset publish`'s npm probe are the two reference behaviours.

## Not verified

- Whether release-please's `changelog-type: github` keeps the "New Contributors" and
  "Full Changelog" sections; the source only prefixes a version heading to the API result.
- Current behaviour of `semantic-release-monorepo` (the second monorepo plugin); only
  multi-semantic-release was checked.
- pnpm 11's `pnpm publish` OIDC path end to end; npm's docs cover the npm CLI, which pnpm
  delegates to.
