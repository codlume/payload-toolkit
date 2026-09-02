# PROTOTYPE — Live Preview linking feel

Throwaway end-to-end slice for [ticket #85](https://github.com/codlume/payload-toolkit/issues/85):
three variants of hover outline, one-shot highlight and scroll-and-expand timing, switchable
via `?variant=A|B|C` on the preview route (bottom bar or ← → keys inside the preview).

## Run

```sh
pnpm --filter @codlume/payload-cms prototype:live-preview
```

Then open http://localhost:3000/admin, log in as `preview@example.com` / `preview-test-password`,
open **Pages → Linking prototype** and turn on Live Preview. The seeded page has blocks three
levels deep; nested blocks fields start collapsed so locate has to expand them.

Nothing here is production code: no tests, minimal error handling, a prototype-only `variant`
message on the bridge, and a `data-lp-proto-type` attribute the real marker will not carry.
