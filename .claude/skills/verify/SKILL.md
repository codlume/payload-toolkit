---
name: verify
description: Launch the Payload Toolkit demo app (apps/payload-cms, Payload Admin plus a Next.js frontend running the activity, blurhash, and live-preview plugins) on an isolated port and database, drive it the way an editor does, and capture screenshots, video, and API reads as proof for a pull request. Use when verifying a change to packages/* or apps/payload-cms end to end, or when asked to run, screenshot, or record the app. payload-roles has no app surface yet; verify it through its integration suite as features/roles.md describes.
---

# Verify Payload Toolkit end to end

Drive the real demo app, not internal setters. Read [features/README.md](features/README.md) first, then follow the feature file for what you changed. All commands run from the repository root.

## Launch

Prerequisites, once per machine:

- `pnpm install --frozen-lockfile`
- Localstack with the `payload-blurhash` bucket. Check with `curl -sI http://127.0.0.1:4566/payload-blurhash`. If it is down, run `pnpm services:up`. All worktrees share one localstack container. Never run `services:up` or `services:down` while another worktree uses it.

Start an instance:

```sh
node .claude/skills/verify/scripts/verify.mjs launch [--mode enabled-in-memory|disabled-in-memory|enabled-temporary-file] [--test-context] [--port <n>] [--no-seed]
```

- It rebuilds `packages/*/dist` when any `dist` is missing or older than `src`. The app imports the plugins from `dist`, so a source edit is invisible until it is rebuilt.
- It starts `next dev` on a free port with its own SQLite database, `.next-e2e-verify-*` dist directory, tsconfig copy, and S3 prefix. Several instances can run side by side.
- Unless `--no-seed` is given, it creates the admin `verify@example.com` / `verify-password` and seeds the page `Verify page` (slug `verify`) with three published text blocks plus a newer draft that reads `Draft block 1..3`.
- Ready means the script printed `verify: ready <run>` with the URLs. The first `/admin` compile takes up to 2 minutes. On failure it prints the path of `server.log`.
- `--mode disabled-in-memory` turns off BlurHash generation and live-preview linking. `--test-context` adds the en/pl localization and the localized Site Settings global that `/preview-global` needs.

The default origin is `http://localhost:<port>`, which is what T3 Code preview tabs load. Live preview drops every message when the browser origin differs from `PAYLOAD_PUBLIC_SERVER_URL`, so open the app at `localhost`, not `127.0.0.1`.

## Doctor

Run this first whenever anything looks off. It is read-only and exits 1 on any failed check.

```sh
node .claude/skills/verify/scripts/verify.mjs doctor [<run>]
```

It checks that the server process is alive, `/admin` answers 200, the seeded admin can log in, the S3 bucket is reachable, the checkout `HEAD` matches the one the run was launched from, and every package `dist` is newer than its `src`. A stale `dist` means the app does not run your change. Run `pnpm build:packages`, then `stop` and `launch` again.

## Drive

Use the browser tool your session has:

- **T3 Code.** Use `preview_open` with `target: {kind: "environment-port", port: <port>, path: "/admin/login"}`, then `preview_act`, `preview_wait_for`, `preview_evaluate`, `preview_snapshot`, and `preview_recording_start` / `preview_recording_stop`.
- **Another browser tool.** Open `http://localhost:<port>/admin/login`.
- **No browser.** Run the Playwright spec that covers the feature (see each feature file) and verify side effects with `api` and `curl`.

Log in by filling `#field-email` and `#field-password`, then pressing Enter or choosing the `Login` button. Wait for the `Pages` link on `/admin`.

Prefer accessible names and the stable attributes listed in each feature file. Payload's own DOM ids (`#field-layout__0__content`, `#layout-row-1`) are Payload 3.88 internals and may change on upgrade.

Read stored state the way a client does:

```sh
node .claude/skills/verify/scripts/verify.mjs api GET '/api/pages/<id>?draft=true&depth=0'
node .claude/skills/verify/scripts/verify.mjs api PATCH '/api/pages/<id>?draft=true' '{"title":"Changed"}'
curl -s http://127.0.0.1:<port>/pages/verify
```

`api` logs in as the seeded admin and prints `{status, json}`. It exits 1 on a 4xx or 5xx response. Use `curl` without a token for what an anonymous visitor sees.

## Evidence

Each run writes to `artifacts/verify/<run>/`, which git ignores:

- `run.json` holds the port, pid, mode, launch HEAD, and paths.
- `server.log` holds the `next dev` output.
- `evidence/` is where proof goes. Copy screenshots and recordings there under names that say what they show, such as `02-preview-click-highlights-admin-row-02.png`.

Proof standards:

- Exercise the real user path: Admin UI, public routes, or REST as a client. Never the Local API with `overrideAccess`, because it skips the access rules that real users hit.
- Capture the action and the resulting state, and for a mutation, a second read of the stored value (`api GET`, or `curl` for the public view).
- Record a short video for an interaction, such as linking, autosave, or upload. Take screenshots for static states.
- Short-lived effects need a probe armed before the action. A highlight lasts 1.2 s, so record it with a `MutationObserver` (see [features/live-preview.md](features/live-preview.md)) instead of a late screenshot.
- Report the feature file and sub-feature ID with each artifact. When a journey cannot run, report the attempted step and the missing precondition. Never report it as verified through a different path.
- Upload the images and video to the pull request description. Do not commit them.

## Cleanup

```sh
node .claude/skills/verify/scripts/verify.mjs stop [<run>|--all]
```

It kills the process group that `launch` started, then removes the run's database, `.next-e2e-verify-*` directory, tsconfig copy, and S3 prefix. It keeps `run.json`, `server.log`, and `evidence/`. Never kill `next` by process name, because other worktrees run their own servers. Run `stop` after every failed attempt too.

## Maintenance

When a feature changes, update its file under `features/` in the same pull request. The state models behind the stateful flows live in [docs/statecharts](../../../docs/statecharts/README.md). Run `/maintain-verification-skill` periodically to re-check the map against the app.
