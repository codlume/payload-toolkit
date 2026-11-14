# Lifecycle enforcement baseline (pages, drafts + trash)

Head 2abc9fa6b0dbd50d5e07516c326750cca10650c8. Apple M3, 8 cores, Darwin 25.6.0 arm64, Node v24.22.2, Payload 3.90.1, sqlite `:memory:`. Three runs, 2026-11-14 12:27 to 12:30 UTC. Load average was 5.7 to 10 on 8 cores (browser, WindowServer, other sessions), so absolute numbers carry machine noise. Sides alternate inside every iteration, so they all see the same noise.

Harness: `packages/payload-roles/tests/integration/lifecycle/perf.bench.ts`.

```
export PATH="$HOME/.nvm/versions/node/v24.22.2/bin:$PATH"
pnpm --filter @codlume/payload-roles build
cd packages/payload-roles
node tests/integration/lifecycle/perf.bench.ts --out <file.json>
```

Defaults are 30 warmup and 200 measured iterations per side per op, 5 counting iterations, 1000 base pages (25% drafts), and a bulk size of 20. Dataset: 1000 pages at start, 2946 after timing, 3092 at end, 14216 page versions at end. The numbers are identical in all runs. Errors: 0 across all runs. Every iteration's write is checked against the stored row, untimed.

The sides are as follows:

- `member` runs with overrideAccess:false. Its role holds all 8 pages actions, and it gets a new user object per call, as an HTTP request does.
- `memberWarm` is the same member with one reused user object, so the capability memo is warm.
- `superAdmin` runs with overrideAccess:false and superAdmin:true.
- `trusted` runs with overrideAccess:true and the member as user.

## Medians (median of the 3 run medians) and p95, ms

| op                        | member          | memberWarm      | superAdmin      | trusted         | run-median spread |
| ------------------------- | --------------- | --------------- | --------------- | --------------- | ----------------- |
| createDraft               | 0.513 / 0.567   | 0.412 / 0.474   | 0.405 / 0.457   | 0.401 / 0.453   | 13%               |
| createPublished           | 0.497 / 0.615   | 0.399 / 0.460   | 0.394 / 0.438   | 0.391 / 0.438   | 10 to 12%         |
| updateDraftSave           | 1.104 / 1.379   | 1.011 / 1.219   | 1.000 / 1.199   | 0.998 / 1.129   | 12 to 13%         |
| updateLiveEdit            | 1.135 / 1.272   | 1.036 / 1.155   | 1.031 / 1.195   | 1.021 / 1.154   | 12 to 13%         |
| unpublish                 | 1.235 / 1.776   | 1.125 / 1.741   | 1.110 / 1.442   | 1.105 / 1.514   | 11 to 13%         |
| moveToTrash               | 1.191 / 2.151   | 1.059 / 1.421   | 1.036 / 1.295   | 1.034 / 1.358   | 13 to 15%         |
| restoreFromTrash          | 1.053 / 1.167   | 0.950 / 1.056   | 0.929 / 1.097   | 0.915 / 1.163   | 20 to 24%         |
| restoreVersion            | 1.149 / 1.364   | 1.033 / 1.159   | 1.025 / 1.132   | 1.023 / 1.149   | 14 to 16%         |
| deletePermanent           | 0.653 / 0.748   | 0.553 / 0.617   | 0.553 / 0.667   | 0.551 / 0.623   | 3 to 7%           |
| bulkUpdate20              | 18.487 / 26.723 | 18.515 / 31.278 | 18.266 / 32.291 | 18.206 / 28.503 | 4 to 5%           |
| restLiveEdit (REST PATCH) | 2.071 / 5.292   | n/a             | 1.914 / 3.992   | n/a             | 53%               |

Spread is (max - min) / median of the three run medians. The per-run deltas between sides are far tighter than the absolute medians, because they are paired within an iteration:

| op             | member - trusted | memberWarm - trusted | superAdmin - trusted |
| -------------- | ---------------- | -------------------- | -------------------- |
| single-doc ops | 0.09 to 0.19     | -0.001 to 0.039      | -0.001 to 0.014      |
| bulkUpdate20   | 0.22 to 0.34     | 0.24 to 0.33         | 0.06 to 0.16         |

## Calls per op (counting pass, 5 iterations, identical across runs)

The member and the trusted side differ by exactly one `db.find roles` plus the `subject` calls, and only on the fresh-user side. `findGlobal` and `findGlobalVersions` are 0 everywhere, because pages is a collection.

| op               | findOne           | find                   | findVersions | subject (member, warm, superAdmin / trusted) | all db calls member / trusted |
| ---------------- | ----------------- | ---------------------- | ------------ | -------------------------------------------- | ----------------------------- |
| createDraft      | 0                 | roles:1 (member only)  | pages:1      | 2 / 0                                        | 4 / 3                         |
| createPublished  | 0                 | roles:1                | pages:1      | 2 / 0                                        | 4 / 3                         |
| updateDraftSave  | 0                 | roles:1                | pages:2      | 2 / 0                                        | 5 / 4                         |
| updateLiveEdit   | 0                 | roles:1                | pages:2      | 2 / 0                                        | 6 / 5                         |
| unpublish        | 0                 | roles:1                | pages:2      | 2 / 0                                        | 6 / 5                         |
| moveToTrash      | 0                 | roles:1                | pages:2      | 3 / 0                                        | 6 / 5                         |
| restoreFromTrash | 0                 | pages:1, roles:1       | pages:1      | 2 / 0                                        | 6 / 5                         |
| restoreVersion   | pages:1 (Payload) | roles:1                | pages:3      | 2 / 0                                        | 7 / 6                         |
| deletePermanent  | pages:1 (Payload) | roles:1                | 0            | 1 / 0                                        | 6 / 5                         |
| bulkUpdate20     | 0                 | pages:1, roles:1       | pages:20     | 2 / 0                                        | 82 / 81                       |
| restLiveEdit     | users:1           | locked-docs:1, roles:1 | pages:2      | 2                                            | 8 / 7 (superAdmin)            |

The callers of `subject` were `plan` once per op and `wrapAccess` once per op (twice for moveToTrash). The only plugin-originated db call was `db.find roles` from `loadRoleGrants`. The lifecycle's own `readRow` `db.findOne` fired 0 times, because a member holding every action never reaches a `depends` verdict. In `memberWarm` the roles lookup shows 0..1 in run 3, where the 5 s memo TTL expired once.

## Limiter

One core, CPU bound: `time` shows 100% CPU. In a profiled run that is not reported here, self time split as follows: libsql 33.5%, drizzle-orm 32.1%, @payloadcms/drizzle 7.0%, payload 3.8%, and payload-roles dist 0.9% of all process time, including setup and checks. The top roles functions were `lookup` (scope) at 0.08%, `resolve` at 0.08% and `can` at 0.06%.

## Reading

Enforced cost over trusted is 0.09 to 0.19 ms per single-doc write, which is 11% (updates at about 1.0 ms) to 28% (creates at about 0.4 ms) of the op. Of that, 0.09 to 0.15 ms is the per-request roles lookup (`member - memberWarm`, one `db.find roles` via `loadRoleGrants`). That lookup is core's resolver, not the lifecycle module. All judging, access plus lifecycle (`memberWarm - trusted`), is at most 0.04 ms per single-doc op, at the noise floor. For bulkUpdate20 it is 0.24 to 0.33 ms (about 12 to 16 µs per document) against an 18 ms op, with run-to-run spread of the absolute median 0.7 ms. On sqlite `:memory:` the roles query is cheap. On a networked database it costs one round trip per request.

Not covered: a partial-grant member that reaches `depends` and the lifecycle `readRow` (one extra `db.findOne` per document, `src/lifecycle/index.ts:283-287`), globals, and uploads.

Raw files sit beside this one: `baseline-run{1,2,3}.json`, `aggregate.mjs` / `aggregate.txt` (rerun with `node aggregate.mjs baseline-run*.json`), and `profsum.mjs` / `profile-summary.txt`.
