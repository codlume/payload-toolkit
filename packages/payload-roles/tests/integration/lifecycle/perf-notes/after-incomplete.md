# Lifecycle enforcement, after: INCOMPLETE (stopped for a machine move)

Status on stop, 2026-11-14 about 15:00 CET. The required 5 alternated runs per side were not completed. One full run per side exists. Nothing below is a verdict on timing. The query counts are deterministic and are complete.

Machine: Apple M3, 8 cores, 8 GB, Darwin 25.6.0 arm64. Node v24.22.2. Payload 3.90.1. sqlite `:memory:`. Local, not CI. The machine was shared with other agent sessions, a VM and Docker. Load average was 6 to 10 during the two usable runs and 24 to 34 afterwards, with 4.9 GB of swap in use.

Dataset (both usable runs): 1000 base pages (25% drafts), 3075 pages after timing, 3350 at end, 27578 page versions at end, 200 measured and 30 warmup iterations per side per op, 5 counting iterations, bulk size 20.

## Commands

```
export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"
pnpm --filter @codlume/payload-roles build        # per commit; the dist is copied to perf/dists/<label>
perf/ab.sh main 5 base gr1 bmc                    # alternates the dists, one full harness run each
node perf/agg.mjs base=perf/runs/main-base-run gr1=perf/runs/main-gr1-run
node perf/micro.mjs perf/src-<label> <label>      # lifecycle-only CPU, no database
cd packages/payload-roles && node <perf>/prove.mjs   # traces the plugin's own reads
```

Labels: `base` is the merge ebd3cca (16a8033 + harness + security fix 23617c0), dist md5 cd7749139792d0f810bbbf60e6660cba. `gr1` is base + the global restore change + the state-column read, dist md5 3c9f8cfdf250fbde8c7fd45c750dd78f. `bmc` is gr1 + the CPU candidates, dist md5 2316f6aaedc22d2cb8207d5fe2de8855. `meta.gitHead` in the JSON is the worktree HEAD when the run started (002bdf0 for both), not the build. `perf/runs/main.log` maps each run to its dist md5.

## What exists

- `perf/runs/main-base-run1.json`, `perf/runs/main-gr1-run1.json`: one full run each, 0 errors. Aggregate: `perf/main-1run.md`.
- `perf/runs/main-bmc-run1.*`: killed mid-run at load 30. No JSON.
- `perf/stale/baseline-base-run1.json`: one run on 1288cdf, before the security fix. Superseded.
- `perf/micro-runs.jsonl`, `perf/micro-summary.md`: lifecycle-only microbenchmark, 5 alternated runs per label, load 3.5 to 8.
- `perf/prove-base.txt`, `perf/prove-gr1.txt`: the plugin's own reads per scenario. The key list there is not evidence of narrowing, because the adapter fills absent keys. `perf/select-check.mjs` prints the SQL.

## Query counts per op (counting pass, 5 iterations, identical within each run)

| op              | side                             | base db calls | gr1 db calls  | change                                                        |
| --------------- | -------------------------------- | ------------- | ------------- | ------------------------------------------------------------- |
| globalRestore   | member                           | 8             | 6             | findGlobal 3 to 2, findGlobalVersions 2 to 1, subject 4 to 3  |
| globalRestore   | memberWarm                       | 7             | 5             | same                                                          |
| globalRestore   | memberPartial                    | 8             | 8             | none (it lacks unpublish, so it is read and judged as before) |
| globalRestore   | trusted                          | 5             | 5             | none                                                          |
| updateLiveEdit  | memberPartial / member / trusted | 7 / 6 / 5     | 7 / 6 / 5     | none: one findOne pages from the lifecycle for memberPartial  |
| editDraft       | memberPartial / member / trusted | 7 / 6 / 5     | 7 / 6 / 5     | none                                                          |
| bulkUpdate20    | memberPartial / member / trusted | 102 / 82 / 81 | 102 / 82 / 81 | none: 20 findOne pages from the lifecycle for memberPartial   |
| bulkEditDraft20 | memberPartial / member / trusted | 102 / 82 / 81 | 102 / 82 / 81 | none                                                          |
| globalEditDraft | memberPartial / member / trusted | 9 / 8 / 7     | 9 / 8 / 7     | none: one extra findGlobal for memberPartial                  |
| probeDocAccess  | member                           | 2, subject 5  | 2, subject 5  | none                                                          |
| probeAccess     | member                           | 2, subject 30 | 2, subject 30 | none                                                          |

## Timing: ONE run per side, not a result

Side median minus the trusted median of the same run, ms (REST ops minus superAdmin):

| op              | side          | base  | gr1   |
| --------------- | ------------- | ----- | ----- |
| globalRestore   | member        | 0.600 | 0.173 |
| globalRestore   | memberWarm    | 0.342 | 0.044 |
| globalRestore   | memberPartial | 0.570 | 0.390 |
| updateLiveEdit  | member        | 0.133 | 0.134 |
| updateLiveEdit  | memberPartial | 0.235 | 0.202 |
| editDraft       | memberPartial | 0.267 | 0.253 |
| bulkUpdate20    | memberPartial | 2.133 | 2.022 |
| bulkEditDraft20 | memberPartial | 3.268 | 1.958 |
| globalEditDraft | memberPartial | 0.232 | 0.232 |
| probeDocAccess  | member        | 0.111 | 0.125 |
| probeAccess     | member        | 0.120 | 0.124 |

Absolute medians and p95 per op and side are in `perf/main-1run.md`. Ops that neither change touches moved by up to 30% between the two runs (createDraft trusted 0.544 to 0.424 ms, unpublish trusted 1.176 to 1.491 ms), so that is the run-to-run noise and no single-run delta here is below it except globalRestore for member, which also has the count change behind it.

## Lifecycle-only CPU (microbenchmark, 5 alternated runs, median [range of run medians], ns)

See `perf/micro-summary.md`. gr1 against bmc: plan + 20 checks 50651 [50400..58734] to 17690 [16295..19400]; a governed probe 743 [682..823] to 362 [340..423]; an ungoverned probe 464 [423..486] to 3 [2..3]. Candidate A (planned facts kept in the plan) 51399 [50374..57047], no change. Against a bulk update of 20 documents at about 23 ms, 33 microseconds is 0.14%.

## Not done

- The 5 alternated full runs per side (base, gr1, bmc), so no before/after table with spread.
- Any usable timing of the state-column read. `perf/read-cost.mjs` ran once per shape at load 18 to 27: thin 1730 against 1039 microseconds per read with overlapping rounds, wide (array of 5 rows and a text list) 639 [326..1182] against 93 [70..225]. One run, overloaded machine.
- The BENCH_WIDE runs.
- A profile of the extended harness.
- `vp fmt --check` and `vp lint` on the tree with the CPU candidates.
