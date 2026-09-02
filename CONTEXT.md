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

**Activity plugin**:
The Payload plugin that attributes changes to admin users, starting with a last-modified-by sidebar field on configured collections and globals.
_Avoid_: Audit log, activity feed, logger

**Attributed edit**:
A change to a configured collection or global made by an authenticated user from the admin user collection; the Activity plugin records that user as the last modifier.
_Avoid_: Any write, system change

**Unattributed edit**:
A change with no admin user behind it (scripts, scheduled jobs, other auth collections); it clears the recorded modifier instead of preserving a stale one.
_Avoid_: Anonymous edit

**Live Preview plugin**:
The Payload plugin that links blocks in Payload Admin to the components rendering them in Payload's Live Preview, in both directions: selecting a component in the preview locates its block in the editor, and selecting a block in the editor locates its component in the preview.
_Avoid_: Visual editor, preview replacement, Payload Live Preview

**Linked block**:
A block-field entry, at any nesting depth, whose rendering component carries a block marker so the Live Preview plugin can locate it from either side.
_Avoid_: Block, component, editable

**Block marker**:
The attributes the Live Preview plugin's frontend helper places on a component so the preview bridge can identify the linked block it renders: the block's row id, which alone identifies it, and its block type, shown in the hover label. It exists only in draft renders; published pages carry none.
_Avoid_: Data attribute, editable tag

**Block renderer**:
The Live Preview plugin's frontend component that maps each block in a document to the developer's registered component for its type, attaching the block marker and passing down draft state and parent props, at any nesting depth.
_Avoid_: Block switch, layout component, RenderBlocks

**Preview bridge**:
The message channel between Payload Admin and the previewed page that carries locate requests in both directions. It stays inert, with no listeners or styles, until the bridge handshake completes, so it does nothing on pages not shown inside Payload Admin.
_Avoid_: Storyblok bridge, postMessage layer, live preview

**Bridge handshake**:
The exchange in which Payload Admin and the previewed page each learn that the other side runs the Live Preview plugin. Either side may start it; until it completes neither side sends or acts on a locate request.
_Avoid_: Payload ready message, connection, ping

**Locate request**:
A message across the preview bridge naming the linked block to reveal, together with its enclosing linked blocks from innermost to outermost. The receiving side reveals the first block it can find and ignores the rest; a request that matches nothing is dropped.
_Avoid_: Selection event, click event, scroll message

**Release**:
A published version of one Payload plugin: its npm version, its git tag, its GitHub Release, and the matching entry in that plugin's changelog. Releases are per plugin; one plugin releasing says nothing about the other.
_Avoid_: Deploy, version bump, lockstep release

**Release contributor**:
A human GitHub user who authored a merged pull request whose change belongs to one Payload plugin's Release. Attribution follows the plugin's Release boundary, not the release run; bots and commit co-authors do not receive credit.
_Avoid_: Commit author, bot author, repository contributor, release-run contributor

**Releasable merge**:
A merge to the default branch that changes a Payload plugin's files with a feature, fix, performance improvement, revert, or breaking change. Other changes to a plugin (docs, tests, tooling) ride along with its next release instead of causing one.
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
