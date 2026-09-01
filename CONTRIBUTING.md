# Contributing

Contributions are welcome. Please keep each change focused.

Search the existing
[issues](https://github.com/codlume/payload-toolkit/issues) and
[pull requests](https://github.com/codlume/payload-toolkit/pulls) before
starting. You can take an open issue without asking for permission. Open an
issue before starting a new feature or behavior change so the scope can be
agreed before implementation. Small fixes and documentation corrections can go
directly to a pull request.

## Local setup

Use Node.js 24.13.1 from [`.node-version`](.node-version). The repository uses
Corepack to select pnpm 11.10.0. Docker with Compose is required for integration,
end-to-end, and full readiness checks.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm browsers:install
```

## Making a change

Create a focused branch from `main` and keep each pull request to one concern.
Published plugin code lives in `packages/*`. The private app in
`apps/payload-cms` exercises the plugins through real Payload APIs and hosts
their integration and end-to-end tests.

Follow the [coding standards](docs/agents/CODING_STANDARDS.md). Add or update
tests when behavior changes, and test through the plugin's public interface
instead of its internal implementation. Run the narrowest matching root command
while you work, such as `pnpm test:unit` or `pnpm test:integration`. Before
opening a pull request, run the full local check:

```sh
pnpm services:up
pnpm ready
pnpm services:down
```

For documentation-only changes, `pnpm fmt:check` is enough locally. CI still
runs the full readiness and minimum compatibility checks on every pull request.

## Pull requests

- Format the title as a
  [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/).
  Allowed types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`,
  `refactor`, `revert`, `style`, and `test`. Examples are
  `fix(payload-activity): preserve attribution` and `docs: clarify local setup`.
  Add `!` before the colon for a breaking change.
- Explain the problem and how the change fixes it. Link the issue with
  `Closes #123` when the pull request resolves one.
- Include before and after images for UI changes. Include a short video when the
  change affects motion or timing.
- Keep generated release files out of the change. Release automation owns
  package versions, changelogs, tags, and GitHub Releases.
- Wait for CI to pass. Pull requests that change a plugin receive a comment
  with a Preview build that can be installed before merge.

When a plugin change ships, the generated changelog and GitHub Release credit
the pull request author.
