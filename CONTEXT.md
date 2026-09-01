# Payload Toolkit

Payload Toolkit is a collection of plugins for Payload CMS. Its shared workspace provides the foundation for developing and releasing those plugins.

## Language

**Workspace skeleton**:
The operational repository foundation: root configuration and tracked `apps/` and `packages/` containers, without a runnable application or publishable package.
_Avoid_: Empty monorepo, starter app

**Validation baseline**:
The root-level gates for formatting and linting, type-checking, unit tests, integration tests, and end-to-end tests that every future workspace project participates in.
_Avoid_: Tooling setup, code validation

**Payload plugin**:
A focused extension for Payload CMS that Payload Toolkit develops for independent release.
_Avoid_: Add-on, workspace package

**Workspace application**:
A non-published Payload CMS application used to demonstrate plugins or exercise them through integration and end-to-end tests.
_Avoid_: Payload plugin, production app

**Internal library**:
A non-published workspace package introduced only when multiple Payload plugins need to share an implementation.
_Avoid_: Payload plugin, configuration package

**BlurHash plugin**:
The Payload plugin that enriches eligible images with a compact placeholder representation and exposes a static preview in Payload Admin.
_Avoid_: Image optimizer, thumbnail generator, logger package

**Eligible image**:
A newly uploaded or replaced static raster asset in a configured media collection that the BlurHash plugin supports.
_Avoid_: Media file, all uploads, existing media

**BlurHash generation**:
The processing attempt for a newly uploaded or replaced asset that ends with a stored BlurHash, an expected skip, or a failure.
_Avoid_: Eligible image generation, image processing

**Activity plugin**:
The Payload plugin that attributes changes to admin users, starting with a last-modified-by sidebar field on configured collections and globals.
_Avoid_: Audit log, activity feed, logger

**Attributed edit**:
A change to a configured collection or global made by an authenticated user from the admin user collection; the Activity plugin records that user as the last modifier.
_Avoid_: Any write, system change

**Unattributed edit**:
A change with no admin user behind it (scripts, scheduled jobs, other auth collections); it clears the recorded modifier instead of preserving a stale one.
_Avoid_: Anonymous edit

**Release**:
A published version of one Payload plugin: its npm version, its git tag, its GitHub Release, and the matching entry in that plugin's changelog. Releases are per plugin; one plugin releasing says nothing about the other.
_Avoid_: Deploy, version bump, lockstep release

**Release contributor**:
A human GitHub user who authored a merged pull request whose change belongs to one Payload plugin's Release. Attribution follows the plugin's Release boundary, not the release run; bots and commit co-authors do not receive credit.
_Avoid_: Commit author, bot author, repository contributor, release-run contributor

**Releasable merge**:
A merge to the default branch that changes a Payload plugin's files with a feature, fix, performance improvement, refactor, revert, or breaking change. Other changes to a plugin (docs, tests, tooling) ride along with its next release instead of causing one.
_Avoid_: Any merge, package-touching commit

**Breaking change**:
A releasable merge whose pull request title carries the `!` marker. While a plugin is on a `0.x` version it bumps the minor; every other releasable merge bumps the patch.
_Avoid_: Major bump, BREAKING CHANGE footer

**Preview build**:
An installable build of a Payload plugin made from an open pull request, for trying the change before it merges. Not a release: no version, no tag, nothing on npm.
_Avoid_: Prerelease, next channel, canary

**Release pull request**:
The pending version bumps and changelog entries for one or more Payload plugins. Its merge sets the release boundary and authorizes publication.
_Avoid_: Feature pull request, manual release

**Release pull request preparation**:
The operation that synchronizes a draft Release pull request's changelogs and body, verifies they belong to its current head, and only then makes it available for maintainer review.
_Avoid_: Contributor enrichment, release pull request update

**Release run**:
The automatic job that prepares or completes a Release. A Releasable merge updates the Release pull request, while merging that pull request authorizes publication; failed work is safe to re-run.
_Avoid_: Deploy job, manual npm publish

**Skipped version**:
A version whose release commit failed its own build. It keeps its changelog entry, tag and GitHub Release but never reaches npm; the fix ships as the next version.
_Avoid_: Failed release, yanked version, broken release
