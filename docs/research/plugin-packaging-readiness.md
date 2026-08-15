# Payload BlurHash plugin packaging, testing, and npm readiness

Research date: 2026-08-16 (Europe/Warsaw)

## Question

What do current official Payload examples, package guidance, npm documentation, and first-party tooling establish as best practice for a TypeScript Payload plugin's package structure, build artifacts, exports, peer dependencies and compatibility policy, Admin component distribution, test application, integration/E2E coverage, public-package metadata, packed-content verification, and provisional naming when actual release automation and publishing are deferred?

## Decision-ready answer

Build one publishable-shaped package at `packages/plugin-blurhash` and one private Payload application at `apps/plugin-blurhash`. The package should expose only:

- `.` for the server-side Payload config plugin and its option types; and
- `./client` for the Admin preview Client Component that Payload's import-map generator must resolve.

Compile both entry points to ESM JavaScript and declarations under `dist/`; point `main`, `types`, and `exports` directly at those built files; and publish only `dist` plus the package README and MIT license. Keep the server entry free of imports from the client entry. Reference the preview from the injected field config as `@payload-toolkit/plugin-blurhash/client#BlurHashPreview`, so the consuming app's generated import map—not a hard-coded relative filesystem path—owns resolution.

Use `payload` as a peer dependency and an exact development dependency. Keep implementation libraries that the plugin itself executes in `dependencies`; keep compilers, test runners, database adapters, Next.js, and the workspace application stack in `devDependencies` or the private application. If the Admin component directly imports React or `@payloadcms/ui`, express those host relationships explicitly as peers and install exact tested versions for development.

For the pre-release phase, use the provisional name `@payload-toolkit/plugin-blurhash`, version `0.0.0`, and `"private": true`. The name is descriptive and follows Payload's first-party `@scope/plugin-name` convention, while `private` makes accidental npm publication fail. Remove `private` and settle the npm scope, version, and compatibility range only at the release-readiness decision.

The workspace application should be the manual demo and the integration/E2E fixture, but it must not be the only package check: workspace links can hide missing build artifacts and undeclared dependencies. Add a package gate that builds, runs `npm pack --dry-run --json`, creates a real tarball, installs that tarball into a clean temporary consumer, imports both public entry points, and generates the Payload import map. Defer Changesets/release orchestration, npm identity and credentials, trusted publishing/provenance, tags, and a publish workflow until there are at least two independently versioned plugins.

## What the primary sources establish

### Payload's supported package shape

Payload defines a plugin as a config-transforming function and recommends its official plugin template for the full development lifecycle. The template contains `src`, a complete development Payload project, Vitest integration tests, Playwright E2E tests, and build scripts that emit JavaScript and declarations to `dist`. It also recommends a disable option, CI tests, npm distribution, a `payload-plugin` repository topic, and SemVer compatibility documentation. ([Payload: Building Your Own Plugin](https://payloadcms.com/docs/plugins/build-your-own), [official template README at Payload v3.88.0](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/README.md))

The versioned template package is ESM, limits packed files to `dist`, builds TypeScript/TSX while preserving the source tree, emits declarations, copies non-code assets, and declares separate root, `./client`, and `./rsc` entry points. Its development stack is not part of the published runtime. ([official template package manifest at Payload v3.88.0](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/package.json), [official template SWC configuration](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/.swcrc))

Payload's first-party SEO plugin demonstrates the useful subset for this plugin: a root entry plus purpose-specific subpath exports, a `files: ["dist"]` allowlist, ESM output, declarations, copied styles/assets, and CSS side-effect declarations. Its published registry manifest resolves every public entry to `dist`, even though the monorepo source manifest is rewritten during Payload's own release process. ([SEO source manifest at Payload v3.88.0](https://github.com/payloadcms/payload/blob/v3.88.0/packages/plugin-seo/package.json), [published `@payloadcms/plugin-seo@3.88.0` registry manifest](https://registry.npmjs.org/@payloadcms%2fplugin-seo/3.88.0))

**Inference for this repository:** do not copy Payload's source-path-plus-`publishConfig` rewrite arrangement. Payload owns release tooling that this repository explicitly does not yet have, and `npm pack` must produce an immediately valid tarball. Put `dist` paths in the ordinary `main`, `types`, and `exports` fields from day one. The builder is an implementation choice: matching Payload's SWC-plus-TypeScript pipeline is safe, but a single TypeScript build is preferable if it can preserve the required ESM module tree, JSX behavior, declarations, source maps, and static assets. The output contract matters more than copying the tool count.

### Public exports and built contents

Node recommends an explicit `type` and `exports` map for a new package; `exports` defines and encapsulates the public subpaths, and `main` can remain as a compatibility fallback. Export targets must be package-relative paths. ([Node.js package documentation](https://nodejs.org/api/packages.html#package-entry-points))

Recommended public surface:

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js",
      "default": "./dist/index.js"
    },
    "./client": {
      "types": "./dist/exports/client.d.ts",
      "import": "./dist/exports/client.js",
      "default": "./dist/exports/client.js"
    }
  },
  "files": ["dist", "README.md", "LICENSE"],
  "sideEffects": ["**/*.css"]
}
```

Use `sideEffects: false` instead if no emitted module imports CSS or another side-effectful asset. Do not add `./rsc`, `./types`, wildcard subpaths, or internal helpers until a consumer actually needs them. The root entry can export the plugin function and its option type, so a separate type subpath has no current value. `./client` is necessary because Payload component paths address a package export directly.

Expected packed output:

```text
dist/
  index.js
  index.d.ts
  plugin.js
  plugin.d.ts
  types.js                 # only if the type module has runtime output
  types.d.ts
  exports/
    client.js
    client.d.ts
  admin/
    BlurHashPreview.js
    BlurHashPreview.d.ts
    BlurHashPreview.css    # only if the implementation uses external CSS
README.md
LICENSE
package.json
```

Source files, test fixtures, the workspace application, screenshots, uploaded media, environment files, caches, and build tooling must not be present. npm's `files` field is an allowlist for packed content, while `package.json`, README, and license are automatically included. ([npm `package.json` documentation](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md#files))

### Server/Admin separation and Payload import maps

Payload component paths are resolved through an automatically generated import map. Package paths and named exports are supported, and the map is generated at application startup/build or with `payload generate:importmap`. ([Payload custom components and import maps](https://payloadcms.com/docs/custom-components/overview#import-map))

The first-party SEO plugin injects a field component path such as `@payloadcms/plugin-seo/client#OverviewComponent`; its `./client` entry then re-exports the actual Client Component. ([SEO field component config](https://github.com/payloadcms/payload/blob/v3.88.0/packages/plugin-seo/src/fields/Overview/index.ts), [SEO client entry](https://github.com/payloadcms/payload/blob/v3.88.0/packages/plugin-seo/src/exports/client.ts)) The official plugin template likewise separates `./client` and `./rsc`, and its generated import map imports those package subpaths. ([template plugin implementation](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/src/index.ts), [template generated import map](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/dev/app/%28payload%29/admin/importMap.js))

Recommended boundary:

```text
Payload config / Node runtime
  imports @payload-toolkit/plugin-blurhash
  injects @payload-toolkit/plugin-blurhash/client#BlurHashPreview as a string

Payload Admin import map
  imports @payload-toolkit/plugin-blurhash/client
  resolves the named BlurHashPreview export
```

The main entry must not re-export or eagerly import `./client`; otherwise Node-side config loading can pull React/Admin code into the server graph. The client entry must begin at the client boundary and must not import image decoding or database/server modules. Add an `./rsc` export only if the preview prototype proves that a distinct Server Component is required.

Payload says Admin Panel components may import from `@payloadcms/ui`; its warning about deep imports applies to a separate frontend bundle. ([Payload custom-component import guidance](https://payloadcms.com/docs/custom-components/overview#imports-best-practices))

**Inference:** if `BlurHashPreview` imports `@payloadcms/ui`, declare it rather than relying on accidental workspace hoisting. Treat it as a host peer, alongside React, and install an exact version in development. This avoids silently shipping a second mismatched Admin UI copy. If the component can be written with React and the typed props it already receives, omit `@payloadcms/ui` entirely.

### Dependencies and compatibility

npm defines peer dependencies for compatibility with a host tool or library and advises plugin authors to use the broadest range they have actually established; runtime implementation packages belong in `dependencies`, while build and test tools belong in `devDependencies`. ([npm dependency and peer-dependency guidance](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md#peerdependencies))

As checked on 2026-08-16, the npm `latest` tag for Payload is `3.88.0`; the `canary` tag is `4.0.0-canary.28`. Payload 3.88.0 declares Node `^18.20.2 || >=20.9.0`. These facts are version-sensitive and must be rechecked before implementation and release. ([Payload registry metadata](https://registry.npmjs.org/payload/latest), [Payload v3.88.0 release](https://github.com/payloadcms/payload/releases/tag/v3.88.0))

Recommended initial policy:

- Develop against exact, aligned Payload packages in the private app (`payload`, `@payloadcms/next`, database adapter, `@payloadcms/ui` when used) so the lockfile is reproducible.
- Start the public Payload peer at the lowest stable version the plugin actually tests. If implementation starts on the current stable API, `^3.88.0` is the honest provisional range; do not claim all of Payload 3 merely because the basic plugin callback existed earlier.
- Do not include Payload 4 prereleases in a stable peer range. Re-evaluate when Payload 4 is stable and the complete suite passes.
- If the client entry imports React, mirror the host-compatible React/React DOM peer ranges and install exact versions as dev dependencies. The first-party SEO 3.88.0 package uses Payload as a peer, React/React DOM as peers, and Admin UI/translations as runtime dependencies. ([published SEO manifest](https://registry.npmjs.org/@payloadcms%2fplugin-seo/3.88.0))
- Put the chosen BlurHash encoder and any decoder directly imported by plugin code in `dependencies`, subject to the separate image-pipeline research. Do not assume an application's transitive install is available.
- Claim only Node versions exercised in CI. `>=20.9.0` is a reasonable candidate floor because it remains within Payload 3.88.0's supported engine range, but the final floor depends on the image stack and compatibility test decision.
- Document Payload compatibility in the README and treat dropping a Payload major or changing an exported entry point as a plugin breaking change. Payload explicitly asks plugin authors to connect their SemVer major versions to supported Payload versions. ([Payload plugin best practices](https://payloadcms.com/docs/plugins/build-your-own#best-practices))

**Inference:** Payload's first-party packages are released in lockstep and therefore use exact internal versions; an independent community plugin should not copy that exact patch coupling unless it intends to publish for every Payload patch. A tested caret peer beginning at the minimum required Payload version better follows npm's host-plugin guidance.

### Workspace application and tests

Payload's template uses a complete, sanitized Payload application for active development, wires the plugin into `payload.config.ts`, initializes real Payload through `getPayload` for integration tests, and runs Playwright against the Admin application. ([template development config](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/dev/payload.config.ts), [template integration test](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/dev/int.spec.ts), [template Playwright config](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/playwright.config.js), [template E2E test](https://github.com/payloadcms/payload/blob/v3.88.0/templates/plugin/dev/e2e.spec.ts))

This repository already reserves `apps/*` for that role, so do not duplicate the template's nested `dev/` project inside the package. Recommended architecture:

```text
packages/plugin-blurhash/       publishable-shaped package
apps/plugin-blurhash/           private Next.js + Payload application
  payload.config.ts
  src/collections/
    Users.ts
    Media.ts                    selected upload collection
    Avatars.ts                  second selected upload collection
    Documents.ts                upload-enabled but unselected control
  src/app/(payload)/...
  src/fixtures/                 small committed image/non-image fixtures
  tests/integration/
  tests/e2e/
```

The app should declare the plugin through `workspace:*`, default to the enabled demo configuration, and be capable of building against the package's `dist` exports. Keep it `private: true`; none of its database, Next.js, Playwright, fixture, or Admin-login dependencies belong in the plugin tarball.

Verification layers:

1. **Package unit/config tests:** option defaults, disabled transform, collection selection, collision/config errors, public export shape, and pure logger adapter behavior.
2. **Payload integration tests:** start Payload with an isolated database/storage directory; create and replace uploads through supported Payload APIs; assert the stored field and Local, REST, and GraphQL response shape; cover two selected collections and an unselected control; cover unsupported files and non-fatal generation failures; and destroy Payload/clean temporary data after each suite. The precise image matrix belongs to the image-pipeline decision.
3. **Admin E2E:** authenticate, upload an eligible image, open/reload the document, assert the static preview and accessible fallback, replace the image, and confirm that an unselected collection is unchanged. Also run a production application build so server/client boundary or import-map failures cannot hide behind the dev server.
4. **Generated artifacts:** run Payload type and import-map generation and fail CI if committed artifacts change. At minimum, assert that the import map resolves `@payload-toolkit/plugin-blurhash/client#BlurHashPreview`.
5. **Compatibility:** before the first public release, run the same integration and app-build smoke test at the minimum claimed Payload version and the newest stable version allowed by the peer range. Do not claim untested minors or a canary major.

The workspace app gives excellent behavioral confidence but not distribution confidence: workspace resolution can see source files, hoisted dependencies, and repository assets that an npm consumer will not receive. That is why the tarball smoke test below is a separate gate.

### Public metadata, documentation, and license

Before implementation is called npm-ready, the package manifest should contain:

- provisional `name` and `version`, plus `private: true` during this phase;
- a plain-language `description` and keywords such as `payload`, `payloadcms`, `cms`, `plugin`, `blurhash`, `image`, and `placeholder`;
- `license: "MIT"` and a package-local `LICENSE` containing the MIT text;
- `author`/maintainer information that the owner approves;
- `repository` with the monorepo URL and `directory: "packages/plugin-blurhash"`;
- `bugs` pointing at this repository's issues and `homepage` pointing at the package README;
- `type`, `main`, `types`, `exports`, `files`, `sideEffects`, `engines`, dependency groups, and package scripts;
- `publishConfig.registry: "https://registry.npmjs.org/"`; add `publishConfig.access: "public"` for the eventual scoped public release.

npm recommends README documentation, review of packed content for secrets/unnecessary files, and installation testing before publication. Scoped public publishing requires an npm user or organization scope and explicit public access; npm also recognizes SPDX license identifiers, repository, bugs, and homepage metadata. ([npm scoped public package guide](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [npm package metadata reference](https://docs.npmjs.com/files/package.json/))

The package README should describe the exact supported Payload range, installation, a typed configuration example, field/API behavior, supported and skipped inputs, synchronous work and size limits, replacement behavior, failure/logging semantics, Admin preview behavior, no-backfill boundary, security/privacy notes, generated-field ownership, development commands, and MIT license. Keep the package marked **unreleased** while `private` is set.

### Pack and clean-consumer verification

`npm pack --dry-run --json` reports the tarball contents without writing a tarball, and `npm pack` creates the same installable artifact. npm recommends installing the package path before publishing; using the actual tarball is a stricter form of that check. ([npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/), [npm scoped-package testing guidance](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/#testing-your-package))

Required pre-release-independent gate:

1. Clean and build `packages/plugin-blurhash`.
2. Run `npm pack --dry-run --json` in that package.
3. Assert the reported file list contains `package.json`, README, LICENSE, and every target referenced by `exports`, with no source, tests, app files, fixtures, secrets, or caches.
4. Run a real `npm pack --json --pack-destination <temporary-directory>`.
5. Create a clean temporary consumer, install the tarball plus exact peer versions, and assert:
   - ESM import of `@payload-toolkit/plugin-blurhash` succeeds;
   - ESM import of `@payload-toolkit/plugin-blurhash/client` succeeds;
   - TypeScript can resolve the option and component declarations;
   - `payload generate:importmap` resolves the named Admin export; and
   - a minimal Payload config initializes.
6. Remove the temporary consumer/tarball after the check.

Use `prepack` for deterministic clean/build work if desired, but keep an explicit `test:pack` script that performs assertions; a successful `npm pack` alone does not prove the artifact contains the right files. `private: true` blocks `npm publish` while still allowing local build and pack inspection. ([npm `private` behavior](https://docs.npmjs.com/cli/v7/configuring-npm/package-json/#private))

### Provisional name and registry status

npm asks for unique, descriptive, lowercase names that do not confuse authorship. A scope groups related packages and can be published only by the owning npm user or organization. ([npm package-name guidelines](https://docs.npmjs.com/package-name-guidelines/), [npm scope documentation](https://docs.npmjs.com/using-npm/scope.html/))

Registry checks on 2026-08-16:

- `@payload-toolkit/plugin-blurhash`: registry lookup returned `404 Not Found`. ([registry request](https://registry.npmjs.org/%40payload-toolkit%2Fplugin-blurhash))
- `payload-plugin-blurhash`: registry lookup returned `404 Not Found`. ([registry request](https://registry.npmjs.org/payload-plugin-blurhash))
- `payload-blurhash`: registry metadata reports that a previous package was unpublished in 2022; avoid it because of history and authorship ambiguity. ([registry request](https://registry.npmjs.org/payload-blurhash))

These are time-sensitive observations, not reservations. A `404` does not prove that the `@payload-toolkit` scope is available or owned by this project, and another publisher can claim an unscoped name. Recommended provisional identity is `@payload-toolkit/plugin-blurhash`, guarded by `private: true`, because the repository is explicitly meant to contain multiple independently released plugins and the name mirrors Payload's first-party convention. Before release, create/secure the npm identity and scope, repeat the registry/name-policy check, confirm trademark-safe wording, remove `private`, and replace the provisional name everywhere—including the component path and generated import map—if the final scope differs.

## What to prepare now

- Publishable-shaped `packages/plugin-blurhash` source and build output contract.
- Minimal `.` and `./client` public API, declarations, and import-map path.
- Exact development stack plus evidence-based peer range.
- Private `apps/plugin-blurhash` demo/integration/E2E app.
- Unit, integration, Admin E2E, production build, type generation, and import-map verification.
- Complete package README, package-local MIT license, public metadata, and `private: true` publication guard.
- Build plus dry-run/real-pack/clean-consumer smoke scripts wired into ordinary CI readiness checks.
- A documented release checklist that records the still-manual decisions without implementing them.

## What to defer until two plugins exist

- npm account/organization creation, scope ownership, tokens, 2FA setup, and actual publication;
- shared Changesets, release-please, semantic-release, or custom version orchestration;
- a publish GitHub Actions workflow, npm trusted publishing/provenance, signing, and release permissions;
- shared changelog, dist-tag, prerelease-channel, and coordinated-version policy;
- a shared package build preset or internal logger package—the second plugin should demonstrate a real repeated contract first;
- cross-package release ordering and repository-wide release commands;
- the first release/version tag and Payload marketplace/community listing work.

Do not defer package-local correctness. A release system can automate a valid tarball later; it cannot compensate for invalid exports, missing declarations, an unresolved Admin component, undeclared runtime dependencies, or an app that only works through workspace leakage.

## Version-sensitive checkpoints

Repeat these checks when implementation begins and immediately before the first release:

1. `payload` latest stable/canary tags and Node engine range.
2. Payload's current plugin template and first-party plugin export/import-map conventions.
3. Minimum and latest Payload versions actually passing integration and production app builds.
4. React, React DOM, `@payloadcms/ui`, Next.js, and database-adapter alignment for the app.
5. npm package and scope availability/ownership.
6. npm's current public publishing authentication, provenance, and access requirements.
