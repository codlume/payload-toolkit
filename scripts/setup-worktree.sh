#!/usr/bin/env bash
# Prepares a fresh git worktree: installs dependencies, builds
# @codlume/payload-blurhash (its exports point at dist/, so nothing resolves
# until it exists), installs the e2e browser, and starts localstack.
# Idempotent — safe to re-run. Wire it up as a t3code action with
# "Run automatically on worktree creation".
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm install
pnpm --filter @codlume/payload-blurhash build
pnpm browsers:install

# The compose project name is fixed, so every worktree shares one localstack.
# Running `up` from a second worktree recreates the container (the bind-mount
# path changes), yanking it out from under tests running elsewhere — so only
# start it when it's down.
if docker info >/dev/null 2>&1; then
  if [ -n "$(docker compose -f compose.yaml ps -q --status running localstack)" ]; then
    echo "localstack already running — leaving it alone"
  else
    pnpm services:up
  fi
else
  echo "docker unavailable — skipped localstack (integration/e2e tests need it)"
fi

echo "worktree ready"
