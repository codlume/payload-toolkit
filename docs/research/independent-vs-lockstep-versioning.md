# Independent vs lockstep versioning for a two-plugin monorepo

Research for [#51](https://github.com/codlume/payload-toolkit/issues/51), part of the
automatic-releases map [#49](https://github.com/codlume/payload-toolkit/issues/49).
Researched 2026-08-29 from primary sources (repo files, registry data, official docs).

## Question

Should `@codlume/payload-activity` and `@codlume/payload-blurhash` each carry their own
version and tag, or share one toolkit version? What does each choice do to tags, GitHub
Releases, GitHub's generated "What's Changed" notes, per-package `CHANGELOG.md`, and npm?

## Recommendation

Version the two plugins independently. Three reasons:

1. They are unrelated. Nothing in `payload-activity` changes when `payload-blurhash` does,
   and a version bump on an untouched package is noise for its users (and, on `0.x`, a
   caret-breaking bump for nothing; see the 0.x research).
2. The README already promises "independently released plugins", and every repo surveyed
   that ships unrelated packages with a release tool (Astro, changesets, google-cloud-node)
   versions them independently. Lockstep is what tightly coupled suites do (Payload core,
   React Router, Vitest, TanStack Query's fixed groups).
3. Both candidate tools that produce per-package changelogs (release-please, changesets)
   default to independent versions and one GitHub Release per package.

Accept the consequence for release notes. GitHub's generated notes cover a tag range, not a
package directory, and the config file can only filter by PR label or author. With two tag
lines, a release for one package would list the other package's PRs unless every PR is
labelled by package and a separate notes config per package excludes the other label. That
is possible (the `generate-notes` API takes `configuration_file_path`, and a path-based
labeler can add the labels), but it is extra machinery for a cosmetic result. The simpler
route is to let the release tool write the release body from the package's own changelog
entry, which already carries the PR link and author, and treat GitHub's notes format as
inspiration rather than a requirement.

Two smaller consequences to design for:

- GitHub shows exactly one "Latest" release per repository. With two independently released
  packages, whichever release is created last (API default `make_latest: true`) or sorts
  highest by semver (`legacy`) wins. Decide which package, if any, should be pinned as Latest
  or accept that the badge is meaningless for a multi-package repo.
- Tag names must carry the package: `payload-blurhash-v0.4.0` (release-please default with
  the npm scope stripped) or `@codlume/payload-blurhash@0.4.0` (changesets default).

If lockstep is chosen anyway, the payoff is one `vX.Y.Z` tag, one GitHub Release with
GitHub's generated notes working as-is, and one "Latest". The cost is the noise above plus a
release tool that fights the model (changesets needs a `fixed` group; release-please needs a
root component plus `linked-versions`).

## Verified facts

### What comparable repos do

| Repo | Versioning | Tags | GitHub Releases | Per-package CHANGELOG | Tool | Release body |
|---|---|---|---|---|---|---|
| payloadcms/payload | Lockstep, every package equals root version | `v3.88.0`, prereleases `v4.0.0-canary.N` | One per version | None | Custom `tools/releaser` (changelogen) | Custom grouped changelog, `generate_release_notes: false` |
| r1tsuu/payload-enchants (9 plugins) | Lockstep until one package moved alone | `1.2.2`, then `translator-1.3.0` | One per publish | None | Custom bump script, manual release | GitHub's "What's Changed" |
| shefing/payload-tools (14 plugins) | Independent | One stray `v1.0.0` | None | None | Manual `workflow_dispatch` per package | n/a |
| withastro/astro | Independent (`linked: []`) | `astro@7.2.9`, `@astrojs/vercel@11.0.8` | One per package | Yes | changesets + changesets/action | Changelog entry copy |
| remix-run/react-router | Lockstep | `react-router@8.3.1` only | One per publish | Root and per package | Custom scripts | Link to CHANGELOG.md |
| TanStack/query | Lockstep inside two `fixed` groups | Per package plus `release-<date>` | Per package plus one aggregate | Yes | changesets + custom script | Changelog copy; aggregate custom |
| vitest-dev/vitest | Lockstep (bumpp) | `v4.1.11` | One per publish | None | bumpp + changelogithub | changelogithub (`by @user in #PR`) |
| changesets/changesets | Independent | `@changesets/cli@3.0.1` | One per package | Yes | changesets/action v2 | Changelog entry copy |
| googleapis/google-cloud-node | Independent (311 packages) | `bigquery-v9.0.3` | One per package | Yes | release-please manifest | Changelog entry copy |

Sources: Payload releaser (`tools/releaser/src/lib/getWorkspace.ts`, `publishList.ts`,
`createDraftGitHubRelease.ts`) and tags via `gh api`; payload-enchants
`scripts/bump-version.ts` and releases `1.2.2`, `translator-1.3.0`; shefing/payload-tools
`.github/workflows/publish-plugin-template.yaml`; Astro `.changeset/config.json` and release
`astro@7.2.9`; react-router `scripts/changes/version.ts`, `scripts/utils/packages.ts`,
`scripts/changes/publish.ts`; TanStack Query `.changeset/config.json` and
`scripts/create-github-release.mjs`; Vitest `scripts/release.ts` and `publish.yml`;
changesets `publish.yml` and `changesets/action` `src/run.ts`; google-cloud-node
`release-please-config.json` and release `bigquery-v9.0.3`.

Pattern: repos whose packages are one product move in lockstep; repos whose packages are
independent tools version independently. The only lockstep plugin collection
(payload-enchants) broke lockstep the first time one plugin needed its own release.

### GitHub generated release notes

- Content: "a list of merged pull requests, a list of contributors to the release, and a
  link to a full changelog." Customisation is label-driven only: `.github/release.yml`
  supports `exclude.labels`, `exclude.authors` and `categories[].labels`. There is no path,
  directory or package filter.
  ([docs](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes))
- The range is a tag range. `POST /repos/{owner}/{repo}/releases/generate-notes` takes
  `previous_tag_name` ("Use to manually specify the range") and `configuration_file_path`
  (a per-call notes config), so per-package notes are possible if PRs carry a package label
  and each package has its own config file. The docs do not say how the previous tag is
  chosen when omitted; with two tag lines, pass it explicitly.
  ([REST docs](https://docs.github.com/en/rest/releases/releases#generate-release-notes-content-for-a-release))
- `gh release create --generate-notes --notes-start-tag <tag>` maps to the same API.
  Custom `body` plus `generate_release_notes: true` prepends the body to the generated notes.
  ([gh manual](https://cli.github.com/manual/gh_release_create),
  [REST create release](https://docs.github.com/en/rest/releases/releases#create-a-release))
- "Latest" is one per repository. `make_latest` defaults to `true` for every new non-draft,
  non-prerelease release; `legacy` picks by creation date and semver; `false` opts out.
  "Drafts and prereleases cannot be set as latest." The semver comparison runs across tag
  names, so two independent lines compete for the badge.
  ([REST create release](https://docs.github.com/en/rest/releases/releases#create-a-release))

### npm

- `repository.directory` in `package.json` is the documented way to point a monorepo
  package at its folder; both manifests already set it.
  ([npm docs](https://docs.npmjs.com/cli/v10/configuring-npm/package-json#repository))
- Provenance and trusted publishing attach to the source commit and workflow file, not to a
  git tag, so tag naming is free to follow the release tool.
  ([provenance](https://docs.npmjs.com/generating-provenance-statements),
  [trusted publishers](https://docs.npmjs.com/trusted-publishers))
- `npm publish` sets `latest` unless `--tag` is given; `next` is the conventional dist-tag
  for upcoming versions; dist-tags must not look like semver ranges.
  ([npm dist-tag](https://docs.npmjs.com/cli/v10/commands/npm-dist-tag))
- Caret ranges on `0.x` accept only patch updates (`^0.2.3 := >=0.2.3 <0.3.0-0`), so a
  lockstep minor bump on an untouched `0.x` package silently moves it out of consumers'
  ranges.
  ([node-semver](https://github.com/npm/node-semver#caret-ranges-123-025-004))

## What this means for the decision ticket (#54)

- Independent versions, tags that include the package name, one GitHub Release per package.
- Release body comes from the package's changelog entry (tool-generated), not from GitHub's
  notes API. Add GitHub's flat "What's Changed" only if a path-based labeler and per-package
  notes configs are judged worth it later.
- Choose how "Latest" is handled (`make_latest: false` on one package, or ignore).
- Per-package `CHANGELOG.md` implies a commit back to `main` by the release tool; the
  tooling ticket covers how each tool does that.

## Not verified

- GitHub's automatic previous-tag choice when `previous_tag_name` is omitted; the docs only
  show a "Previous tag: auto" dropdown.
- Whether every payload-enchants lockstep release used GitHub's generated notes (only
  `1.2.2` and `translator-1.3.0` were checked).
- Additional multi-package Payload plugin repos beyond payload-enchants and payload-tools;
  GitHub search was rate-limited during the survey.
