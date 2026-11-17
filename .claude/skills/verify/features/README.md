# Payload Toolkit feature map

This map lists every feature and user flow of the toolkit and the demo app, how to check each one, and what proof to capture. Use the index to pick the feature that a change touches, then follow its file as the recipe.

## Baseline preconditions

- Launch an instance with `node .claude/skills/verify/scripts/verify.mjs launch` and wait for `verify: ready`.
- Run `node .claude/skills/verify/scripts/verify.mjs doctor` and require every line to be `ok`.
- The seeded admin is `verify@example.com` / `verify-password`. The seeded page is `Verify page` (slug `verify`, id in the `launch` output) with published blocks `Published block 1..3` and a newer draft `Draft block 1..3`.
- In the steps below, `<origin>` is the `http://localhost:<port>` that `launch` printed and `verify` is shorthand for `node .claude/skills/verify/scripts/verify.mjs`.
- Never drive an instance that this run did not launch.

## Driving conventions

- Start each recipe from a fresh `launch` unless its preconditions say otherwise. Recipes that mutate shared data name what they change.
- Prefer accessible names (`role=button[name="Publish changes"]`) and the plugin `data-*` attributes over CSS classes and coordinates.
- Treat quoted labels and commands as literal.

## Proof and skip reporting

- Capture the user action and the resulting state. For a mutation, add a second read of the stored value with `verify api` or `curl`.
- Save artifacts under `artifacts/verify/<run>/evidence/` and name each one with the sub-feature ID it proves.
- Report an unreachable path with the attempted step and the unmet precondition. Do not report it as verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 and one paragraph on the user-visible behavior, then four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, and `Gotchas`.

## Features

| Feature                                        | Check it with                                                                                                                | Proof to capture                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| [Admin shell and sign-in](./admin-shell.md)    | `verify launch`, then log in at `<origin>/admin/login`                                                                       | Screenshot of the dashboard listing Media, Users, Pages, and Site Settings             |
| [Drafts, publishing, and preview](./drafts.md) | `<origin>/admin/collections/pages/<id>`, `curl <origin>/pages/verify`, `pnpm --filter @codlume/payload-cms test:integration` | Screenshot of the status line, and the anonymous page body before and after publishing |
| [Live preview linking](./live-preview.md)      | Live Preview pane on the seeded page; `pnpm --filter @codlume/payload-cms test:e2e live-preview.e2e.test.ts`                 | Video of both directions, plus the highlight probe output                              |
| [BlurHash placeholders](./blurhash.md)         | Upload at `<origin>/admin/collections/media/create`; `verify api GET /api/media/<id>`                                        | Screenshot of the BlurHash panel, and the `blurHash` value from the API                |
| [Last Modified By attribution](./activity.md)  | Sidebar of a media document or `<origin>/admin/globals/site-settings`; `verify api GET`                                      | Screenshot of the sidebar field, and `lastModifiedBy` from the API                     |
| [Roles and permissions](./roles.md)            | `pnpm --filter @codlume/payload-roles test:integration` (no app surface yet)                                                 | Test summary lines for the suites the change touches                                   |
| Plugin packaging (all packages)                | `pnpm test:build && pnpm test:pack`                                                                                          | Command output                                                                         |
| Full readiness (what CI runs)                  | `pnpm services:up && pnpm ready`, plus `pnpm test:compat minimum`                                                            | CI checks on the pull request                                                          |

The stateful flows have checked state models with Mermaid charts in [docs/statecharts](../../../../docs/statecharts/README.md). Read the chart before changing a flow, and update its model when a rule changes.
