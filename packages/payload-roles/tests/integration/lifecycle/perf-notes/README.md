# Lifecycle benchmark notes (handoff, work in progress)

Data for PR #128's performance work, kept here so it survives a machine move. Source for every
number: Apple M3 (8 cores, 8 GB), macOS (Darwin 25.6), Node 24.22.2, Payload 3.90.1, SQLite
`:memory:`, run locally on a shared machine (load average 6 to 10 during usable runs). Dataset:
1000 base pages at start, about 3075 after timing, 200 measured iterations, bulk size 20.

- `baseline.md` holds the complete baseline on 2abc9fa: three runs per side.
- `after-incomplete.md` is incomplete. It has one run per side, not the five alternated runs the
  benchmark checklist requires. Only the count changes are conclusive.
- `micro-summary.md` holds the lifecycle-only CPU microbenchmark: five alternated runs, no
  database.
- `raw-data.tar.gz` holds the raw run JSON, logs, aggregation scripts, candidate patches and the
  local proof logs. Extract it with `tar -xzf raw-data.tar.gz`.

To rerun, from the repo root with Node 24:

```sh
pnpm --filter @codlume/payload-roles build
cd packages/payload-roles
node tests/integration/lifecycle/perf.bench.ts --out run.json
```
