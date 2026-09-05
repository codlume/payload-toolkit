# Contributor guidance in comparable open-source projects

## Recommendation

Add a root `CONTRIBUTING.md` and keep the README contribution section to one
sentence linking to it. GitHub automatically links a recognized contributor
guide when someone opens an issue or pull request, on the repository's
`contribute` page, in the repository overview, and in the sidebar
([GitHub contributor-guideline documentation](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/setting-guidelines-for-repository-contributors)).
Payload and Vite use exactly this README-to-guide split
([Payload README](https://github.com/payloadcms/payload/blob/main/README.md#L111-L113),
[Vite README](https://github.com/vitejs/vite/blob/main/README.md#L52-L54)).

For Payload Toolkit, the guide should cover only the public contribution path:

1. Ask contributors to search open and closed issues and linked pull requests.
   Small documentation corrections can go straight to a pull request. New
   features and behavior changes should start with an issue so scope can be
   agreed before implementation.
2. State the exact prerequisites from the repository: Node.js `24.13.1`, pnpm
   `11.10.0`, and Docker only for checks that use LocalStack. Give a short setup
   path beginning with `pnpm install`.
3. Explain the monorepo boundary in a few lines. `packages/*` contains the
   published plugins, while `apps/payload-cms` is the private development and
   test application.
4. Tell contributors to add or update tests, run the checks relevant to the
   changed package, and use the repository's full readiness command before a
   pull request when their environment supports it. List exact commands, not a
   generic instruction to "run the tests."
5. Reuse the repository's current pull request rules: one concern per pull
   request, a linked issue when one exists, a Conventional Commit title, a clear
   problem and solution, and before/after media for UI or motion changes.
6. Keep conduct and vulnerability reporting in `CODE_OF_CONDUCT.md` and
   `SECURITY.md`, then link those files from `CONTRIBUTING.md`. Do not duplicate
   contact details in several places.

This is enough for a small plugin monorepo. Next.js needs a contributor index
and several sub-guides because its setup and test matrix are large
([Next.js contributor index](https://github.com/vercel/next.js/blob/canary/contributing.md#L30-L53)).
Payload Toolkit does not need that hierarchy yet.

## What established projects document

| Project | Structure and discovery                                                                                                                                                                                   | Before coding                                                                                                                                                                                                                    | Setup, tests, and pull requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Conduct and security                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload | A short README section links to a root `CONTRIBUTING.md` ([README](https://github.com/payloadcms/payload/blob/main/README.md#L111-L113)).                                                                 | Contributors search existing issues. New features and design changes are discussed before implementation ([guide](https://github.com/payloadcms/payload/blob/main/CONTRIBUTING.md#L5-L31)).                                      | The guide pins the package manager and tool versions, explains test fixtures and commands, and requires descriptive pull requests with Conventional Commit titles ([setup](https://github.com/payloadcms/payload/blob/main/CONTRIBUTING.md#L33-L39), [tests](https://github.com/payloadcms/payload/blob/main/CONTRIBUTING.md#L94-L117), [pull requests](https://github.com/payloadcms/payload/blob/main/CONTRIBUTING.md#L241-L270)).                                                                                                                                                                                                                                                                                 | It has a separate [`SECURITY.md`](https://github.com/payloadcms/payload/blob/main/SECURITY.md). Its contributor guide also repeats a security contact, but the two files currently name different addresses ([contributor guide](https://github.com/payloadcms/payload/blob/main/CONTRIBUTING.md#L9-L13), [security policy](https://github.com/payloadcms/payload/blob/main/SECURITY.md#L1-L3)). That drift is a good reason to keep one reporting source. |
| pnpm    | A root `CONTRIBUTING.md` holds the complete workflow and a table of contents ([guide](https://github.com/pnpm/pnpm/blob/main/CONTRIBUTING.md#L1-L21)).                                                    | The pull request checklist tells contributors to inspect an issue's linked pull requests and avoid competing fixes ([checklist](https://github.com/pnpm/pnpm/blob/main/CONTRIBUTING.md#L217-L226)).                              | Setup names exact commands and supports both full and package-filtered tests. The pull request flow requires tests, a changeset, a green full suite, and conventional commit messages ([setup](https://github.com/pnpm/pnpm/blob/main/CONTRIBUTING.md#L23-L35), [pull requests](https://github.com/pnpm/pnpm/blob/main/CONTRIBUTING.md#L217-L255), [commit format](https://github.com/pnpm/pnpm/blob/main/CONTRIBUTING.md#L326-L389)).                                                                                                                                                                                                                                                                               | It keeps the [`CODE_OF_CONDUCT.md`](https://github.com/pnpm/pnpm/blob/main/CODE_OF_CONDUCT.md) and [`SECURITY.md`](https://github.com/pnpm/pnpm/blob/main/SECURITY.md) separate.                                                                                                                                                                                                                                                                           |
| Vite    | Its README has one link to a root contributor guide ([README](https://github.com/vitejs/vite/blob/main/README.md#L52-L54)).                                                                               | Work on an open issue needs no permission. A new feature should have an approved suggestion issue first ([guide](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#L235-L245)).                                           | The guide gives a two-command setup, targeted and full test commands, test expectations for features and bugs, and a changelog-compatible PR title rule ([setup](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#L5-L17), [tests](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#L137-L165), [pull requests](https://github.com/vitejs/vite/blob/main/CONTRIBUTING.md#L235-L262)).                                                                                                                                                                                                                                                                                                                | Vulnerability reporting lives in [`.github/SECURITY.md`](https://github.com/vitejs/vite/blob/main/.github/SECURITY.md).                                                                                                                                                                                                                                                                                                                                    |
| Next.js | A short root `contributing.md` routes readers to separate setup, testing, documentation, triage, and pull request files ([index](https://github.com/vercel/next.js/blob/canary/contributing.md#L30-L53)). | Contributors search issues and pull requests first. They may take any open issue without permission, while features need an accepted discussion ([guide](https://github.com/vercel/next.js/blob/canary/contributing.md#L1-L14)). | The development guide names the base branch, prerequisites, installation, build, and pull request steps. The testing guide recommends targeted suites and requires a regression test to fail without the fix. A small PR guide asks for purpose and related issues ([development](https://github.com/vercel/next.js/blob/canary/contributing/core/developing.md#L3-L31), [local setup](https://github.com/vercel/next.js/blob/canary/contributing/core/developing.md#L51-L116), [testing](https://github.com/vercel/next.js/blob/canary/contributing/core/testing.md#L1-L78), [pull request description](https://github.com/vercel/next.js/blob/canary/contributing/repository/pull-request-descriptions.md#L1-L7)). | Community behavior has its own [`CODE_OF_CONDUCT.md`](https://github.com/vercel/next.js/blob/canary/CODE_OF_CONDUCT.md).                                                                                                                                                                                                                                                                                                                                   |

## Practical conclusions

- The README is the signpost, not the complete workflow.
- Issue-first does not need to mean permission-first. The useful distinction is
  between an already-scoped issue and a new feature that still needs agreement.
- Setup instructions should match the repository's pinned tools and commands.
  Copying a generic fork-and-clone tutorial adds length without preventing the
  failures contributors actually hit.
- Test guidance works best when it names a fast, targeted path and the broader
  pre-submission check. pnpm and Next.js both make that distinction.
- Pull request rules should explain the review contract: scope, evidence, title,
  linked issue, and tests. Release-specific steps belong here only when a
  contributor must perform them.
- Add a code of conduct only if maintainers can enforce it. GitHub explicitly
  recommends choosing one that fits the community and checking that enforcement
  is realistic
  ([GitHub code-of-conduct documentation](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/adding-a-code-of-conduct-to-your-project)).
- Security reports need a private, maintained route. GitHub treats
  `SECURITY.md` as the dedicated file for vulnerability-reporting instructions
  ([GitHub community-health file documentation](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file#supported-file-types)).
