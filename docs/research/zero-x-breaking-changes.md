# Bumping 0.x packages on breaking changes

Research for [#53](https://github.com/codlume/payload-toolkit/issues/53), part of the
automatic-releases map [#49](https://github.com/codlume/payload-toolkit/issues/49).
Researched 2026-08-29.

## Question

While `@codlume/payload-activity` and `@codlume/payload-blurhash` are `0.x`, what should a
`feat!:` or `BREAKING CHANGE` PR title do to the version, what do release-please, changesets
and semantic-release do by default, and how is the move to `1.0.0` kept deliberate?

## Recommendation

1. Stay on `0.x` and let breaking changes bump the minor. Every non-breaking change bumps the
   patch. So `feat!:` takes `0.3.4` to `0.4.0`; `feat:` and `fix:` both take it to `0.3.5`.
   This is the only scheme where the version number and npm's default `^` range agree:
   `^0.3.4` accepts `0.3.x` and rejects `0.4.0`, so consumers keep receiving compatible updates
   and never receive a breaking one by accident.
2. Do it with release-please. Set `"bump-minor-pre-major": true` and
   `"bump-patch-for-minor-pre-major": true` at the top level of `release-please-config.json`
   so both packages inherit them. Both options are no-ops once a package's major is `>= 1`, so
   nothing has to be removed after `1.0.0`.
3. Make `1.0.0` a config change, not a PR title. With the flags on, no conventional commit can
   ever produce `1.0.0`; the only routes are a `Release-As: 1.0.0` footer in the squash commit
   body or a one-line `"release-as": "1.0.0"` entry for that package in
   `release-please-config.json` (removed in the release PR or right after). Prefer the config
   entry: it is reviewable, per package, and does not depend on the repository's squash-merge
   message setting keeping the PR body.
4. Rule out semantic-release for this question. It has no `0.x` mode and its maintainers
   declined to add one; a breaking change on `0.x` goes straight to `1.0.0`. Changesets can
   stay `0.x` but has no config to make a `major` changeset bump the minor, and its only guard
   is an interactive CLI prompt that never runs in a PR-title-driven flow.
5. Keep the changelog honest. release-please's changelog renders a `⚠ BREAKING CHANGES`
   section from the commit notes regardless of which component was bumped, so a `0.3.4` to
   `0.4.0` entry still shouts. Do what esbuild does and treat every `0.x.0` release as one that
   may break.

## Verified facts

### Semver spec

- Item 4: "Major version zero (0.y.z) is for initial development. Anything MAY change at any
  time. The public API SHOULD NOT be considered stable." Item 5: "Version 1.0.0 defines the
  public API." ([semver.org](https://semver.org/#spec-item-4))
- The FAQ on the `0.y.z` phase: "The simplest thing to do is start your initial development
  release at 0.1.0 and then increment the minor version for each subsequent release."
  ([semver.org FAQ](https://semver.org/#how-should-i-deal-with-revisions-in-the-0yz-initial-development-phase))
- On when to go `1.0.0`: "If your software is being used in production, it should probably
  already be 1.0.0. If you have a stable API on which users have come to depend, you should
  be 1.0.0. If you're worrying a lot about backward compatibility, you should probably already
  be 1.0.0." ([semver.org FAQ](https://semver.org/#how-do-i-know-when-to-release-100))
- The spec only mandates a major bump for incompatible changes when `X > 0` ("Major version X
  (X.y.z | X > 0) MUST be incremented if any backward incompatible changes are introduced").
  Below `1.0.0` it is silent, which is why tools disagree. ([semver.org](https://semver.org/#spec-item-8))

### npm caret ranges on 0.x

- node-semver, which npm and pnpm use for range resolution: caret "Allows changes that do not
  modify the left-most non-zero element in the `[major, minor, patch]` tuple." Examples:
  `^0.2.3 := >=0.2.3 <0.3.0-0`, `^0.0.3 := >=0.0.3 <0.0.4-0`.
  ([node-semver README](https://github.com/npm/node-semver#caret-ranges-123-025-004))
- Checked locally with `semver@7`: `0.2.9` satisfies `^0.2.3`, `0.3.0` does not; `0.0.4` does
  not satisfy `^0.0.3`. So on `0.y.z` with `y >= 1`, the minor is the compatibility line and
  the patch is the only thing consumers pick up automatically. On `0.0.z` nothing is picked up.
- `semver.inc('0.5.2', 'major')` is `1.0.0`, `inc('0.5.2', 'minor')` is `0.6.0`. There is no
  `0.x`-aware increment. isaacs closed the request for one: "This is working as designed. The
  technical term for the first number in the tuple is 'major'. If you want to increment the
  minor version for a breaking change, then that's your call, and the semver specification is
  ambivalent about doing so in a 0.x version."
  ([npm/node-semver#177](https://github.com/npm/node-semver/issues/177#issuecomment-263352140))

### Conventional Commits

- `fix` maps to PATCH, `feat` to MINOR, and "Commits with BREAKING CHANGE in the commits,
  regardless of type, should be translated to MAJOR releases." Breaking is flagged by `!`
  before the colon or a `BREAKING CHANGE:` footer.
  ([conventionalcommits.org](https://www.conventionalcommits.org/en/v1.0.0/#summary))
- The spec's own FAQ on the initial development phase does not endorse `0.x` semantics: "We
  recommend that you proceed as if you've already released the product."
  ([conventionalcommits.org FAQ](https://www.conventionalcommits.org/en/v1.0.0/#what-do-i-do-if-i-accidentally-use-the-wrong-commit-type))
- The shared `conventional-recommended-bump` library refused to special-case `0.x` in 2018 and
  left it to downstream tools: it "simply determines what type of change was made (major,
  minor, patch) and defers to the downstream user as to what version number is generated from
  that release type." The request that prompted it described the default exactly: "Breaking
  changes bump semver-major version to 1.0.0. This is almost never wanted!"
  ([conventional-changelog#294](https://github.com/conventional-changelog/conventional-changelog/issues/294))

### release-please

- Default versioning: "Breaking changes bump the major version, features bump the minor
  version, bugfixes bump the patch version."
  ([docs/customizing.md](https://github.com/googleapis/release-please/blob/main/docs/customizing.md#versioning-strategies))
- Two options, both defaulting to `false`, settable at the top level or per package:
  `bump-minor-pre-major`: "BREAKING CHANGE only bumps semver minor if version < 1.0.0";
  `bump-patch-for-minor-pre-major`: "feat commits bump semver patch instead of minor if
  version < 1.0.0".
  ([docs/manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md),
  [schemas/config.json](https://github.com/googleapis/release-please/blob/main/schemas/config.json))
- Source confirms the gate is `version.major < 1` (`isPreMajor` in
  [src/version.ts](https://github.com/googleapis/release-please/blob/main/src/version.ts)).
  In `DefaultVersioningStrategy`, a `Release-As` note wins outright; otherwise breaking with
  `isPreMajor && bumpMinorPreMajor` returns a minor update instead of major, and a feature with
  `isPreMajor && bumpPatchForMinorPreMajor` returns a patch update instead of minor.
  ([src/versioning-strategies/default.ts](https://github.com/googleapis/release-please/blob/main/src/versioning-strategies/default.ts))
- The `prerelease` strategy applies the same two flags before adding the prerelease suffix, so
  the scheme carries over to a `next` channel unchanged.
  ([src/versioning-strategies/prerelease.ts](https://github.com/googleapis/release-please/blob/main/src/versioning-strategies/prerelease.ts))
- Forcing a version: put `Release-As: x.x.x` in the commit body (case-insensitive), for example
  `git commit --allow-empty -m "chore: release 2.0.0" -m "Release-As: 2.0.0"`.
  ([README](https://github.com/googleapis/release-please#how-do-i-change-the-version-number))
  The manifest also accepts `"release-as": "1.2.3"` per package, with the note to remove or
  update it after the release PR merges so later runs do not reuse it, and `"initial-version"`
  for a package's first release.
  ([docs/manifest-releaser.md](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md),
  [schemas/config.json](https://github.com/googleapis/release-please/blob/main/schemas/config.json))
- Changelog notes come from `conventional-changelog-writer` with the `conventionalcommits`
  preset, filtering commit notes titled `BREAKING CHANGE`; the bump strategy is a separate
  module, so the section is rendered whatever the bump. release-please's own CHANGELOG shows
  the resulting `### ⚠ BREAKING CHANGES` heading.
  ([src/changelog-notes/default.ts](https://github.com/googleapis/release-please/blob/main/src/changelog-notes/default.ts),
  [CHANGELOG.md](https://github.com/googleapis/release-please/blob/main/CHANGELOG.md))
- In the wild: a GitHub code search for `bump-minor-pre-major` in `release-please-config.json`
  hits the 100-result cap. `openai/openai-go` sets `"bump-minor-pre-major": true` with
  `"bump-patch-for-minor-pre-major": false`; `puppeteer/puppeteer` sets
  `"bump-minor-pre-major": true` on just its `packages/ng-schematics` entry inside a monorepo
  manifest, which is the per-package override shape this repo would use.
  ([openai-go config](https://github.com/openai/openai-go/blob/main/release-please-config.json),
  [puppeteer config](https://github.com/puppeteer/puppeteer/blob/main/release-please-config.json))

### changesets

- Version math is `semver.inc(oldVersion, type)` with no `0.x` branch, so a `major` changeset on
  `0.5.2` yields `1.0.0`.
  ([assemble-release-plan/src/increment.ts](https://github.com/changesets/changesets/blob/main/packages/assemble-release-plan/src/increment.ts))
- The only guard is in the interactive `changeset add` prompt: for packages below `1.0.0` it
  warns "The major version of <name> will be its first major release (1.0.0)" and asks "Are
  you sure you want to release the first major version", because "some repo-wide sweeping
  changes have mistakenly release first majors of packages." Bots that write changeset files
  from PR metadata bypass this prompt.
  ([cli/src/commands/add/createChangeset.ts](https://github.com/changesets/changesets/blob/main/packages/cli/src/commands/add/createChangeset.ts))
- None of the docs (`decisions.md`, `prereleases.md`, `common-questions.md`, `dictionary.md`)
  mention `0.x`; bump types are only `major | minor | patch | none`.
  ([docs/dictionary.md](https://github.com/changesets/changesets/blob/main/docs/dictionary.md))

### semantic-release

- Default release rules in `@semantic-release/commit-analyzer`: breaking to `major`, `feat` to
  `minor`, `fix` and `perf` to `patch`; the highest matching type wins. No option references
  versions below `1.0.0`.
  ([commit-analyzer README](https://github.com/semantic-release/commit-analyzer#releaserules))
- FAQ "Can I set the initial release version of my package to 0.0.1?": "This is not supported
  by semantic-release. Semantic Versioning rules apply differently to major version zero and
  supporting those differences is out of scope and not one of the goals of the
  semantic-release project." It points to pre-releases instead, and to a placeholder
  `"version": "0.0.0-development"` in `package.json`.
  ([semantic-release FAQ](https://semantic-release.gitbook.io/semantic-release/support/faq#can-i-set-the-initial-release-version-of-my-package-to-0-0-1))
- The feature request was closed by a maintainer in 2020: "We will not be implementing it in
  semantic-release. And we have an alternative solution that is supported today: using
  pre-release channels." A later comment in the thread confirms the behaviour if you start
  from a hand-published `0.x` tag: a feature bumps `0.1.0` to `0.2.0` and a breaking change
  bumps it to `1.0.0`.
  ([semantic-release#1507](https://github.com/semantic-release/semantic-release/issues/1507))

### How libraries handle 0.x and the move to 1.0

- React Native, on `0.x` for over a decade, documents the scheme this note recommends for the
  breaking case: "Breaking changes will be shipped in a new minor version" and "Critical bug
  fixes will be shipped in a new patch version." Features also go in the minor.
  ([reactnative.dev versioning policy](https://reactnative.dev/docs/releases/versioning-policy))
- esbuild puts breaking changes only in `0.x.0` releases and prefixes each such entry (0.19.0,
  0.22.0, 0.23.0, 0.24.0 and others) with: "This release deliberately contains
  backwards-incompatible changes. To avoid automatically picking up releases like this, you
  should either be pinning the exact version of esbuild in your package.json file
  (recommended) or be using a version range syntax that only accepts patch upgrades such as
  ^0.23.0 or ~0.23.0."
  ([esbuild CHANGELOG-2024.md](https://github.com/evanw/esbuild/blob/main/CHANGELOG-2024.md))
- Vitest went `0.34.6` (2023-09-29) to `1.0.0-beta.0` through `1.0.0-beta.6`, then `1.0.0`
  on 2023-12-04 with its own migration guide. The major was a planned two-month beta, not a
  single breaking PR.
  ([vitest v1.0.0 release](https://github.com/vitest-dev/vitest/releases/tag/v1.0.0))
- Astro shipped a public beta in April 2022 and `1.0` in August 2022: "This v1.0 release
  symbolizes our commitment to API stability and production-readiness going forward."
  ([astro.build](https://astro.build/blog/astro-1/))
- Payload itself shipped breaking changes in `0.x` minors ("the only breaking change in this
  minor version release is related to GraphQL errors", 0.15.0, 2022-03-17) and announced
  `1.0` on 2022-07-18 "After being in public beta for over a year and a half", with "only one
  breaking change, and it's a trivial migration."
  ([Payload 0.15.0 post](https://payloadcms.com/posts/blog/version-0-15-0),
  [Payload 1.0 post](https://payloadcms.com/posts/blog/payload-launches-version-1))

## What this means for the spec (#54)

- Both packages start at `0.1.0` (semver FAQ), not `0.0.x`, because `^0.0.z` accepts nothing.
  release-please can set this with `"initial-version"` per package, or the first hand publish
  can simply be `0.1.0`.
- Top-level `"bump-minor-pre-major": true` and `"bump-patch-for-minor-pre-major": true`.
  A `feat!:` PR title becomes a `0.(y+1).0` release with a `⚠ BREAKING CHANGES` changelog
  section. `feat:` and `fix:` both become `0.y.(z+1)`.
- If the owner would rather keep `feat` visible in the version (`0.3.4` to `0.4.0` for a
  feature), drop `bump-patch-for-minor-pre-major`. The cost is that `^` consumers then stop
  receiving features automatically, and a minor no longer means "may break". openai-go made
  that trade; esbuild and the semver FAQ did not.
- `1.0.0` is out of scope for #49, but the mechanism should be named in the spec: a PR that
  adds `"release-as": "1.0.0"` to that package's manifest entry, merged like any other PR.
  Because `bump-minor-pre-major` can never reach `1.0.0` on its own, no PR title can trigger
  it by accident.
- If the `Release-As` footer route is chosen instead, the spec must require the repository's
  squash-merge default message to include the PR description, or the footer never reaches
  `main`.

## Not verified

- Whether release-please's GitHub Release for a `0.x` version is marked "Pre-release" depends
  on the `prerelease` manifest flag ("create those as 'Prerelease' releases that have
  pre-major or prerelease versions", default `false`). Worth a check in the prerelease ticket.
- Anthropic's TypeScript SDK is still on `0.122.0` in August 2026 with release-please, but
  its root manifest entry was not confirmed to set the pre-major flags, so it is not cited
  above as evidence.
