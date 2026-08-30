# Preserve per-plugin release notes when crediting contributors

GitHub generates its Contributors panel from `@username` mentions in a Release body, but its generated notes compare repository-wide tag ranges and cannot filter changes by plugin path. We will preserve release-please's per-plugin release boundaries and enrich its selected changes with pull request author mentions for future changelogs and GitHub Releases; the one-time historical backfill will update existing GitHub Release bodies without rewriting generated changelogs.
