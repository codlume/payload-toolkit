# Payload Activity

## Unreleased

`@codlume/payload-activity` is private and has not been published. The package
name and Codlume npm scope are provisional and are not claimed or reserved.

## Compatibility

- Payload >=3.88.0 <4
- Node >=22.12.0 <23 or >=24.0.0 <25

## Configuration

Register the plugin once and list the collections and globals that need edit
attribution. Generated Payload types provide completion for both slug types.

```ts
import { activityPlugin } from "@codlume/payload-activity";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [
    { auth: true, fields: [], slug: "users" },
    { fields: [], slug: "posts" },
  ],
  globals: [{ fields: [], slug: "site-settings" }],
  plugins: [
    activityPlugin({
      collections: ["posts"],
      globals: ["site-settings"],
    }),
  ],
});
```

At least one collection or global is required.

| Option        | Type               | Default            |
| ------------- | ------------------ | ------------------ |
| `collections` | `CollectionSlug[]` | No collections     |
| `globals`     | `GlobalSlug[]`     | No globals         |
| `enabled`     | `boolean`          | `true`             |
| `debug`       | `boolean`          | `false`            |
| `fieldName`   | `string`           | `"lastModifiedBy"` |

Configuration errors are reported together at startup. The plugin rejects
missing targets and empty, duplicate, malformed, or unknown collection and
global slugs. It also rejects unsafe, reserved, or colliding field names,
duplicate registration, and an invalid admin user collection. The `debug`
option enables structured attribution diagnostics through Payload's logger.

## Attribution behavior

Each configured collection and global receives a nullable relationship to the
admin user collection. The field is read-only in Admin and denies direct create
and update access. An edit made by an admin user stores that user's ID. A write
without a user, or with a user from another auth collection, stores `null` so
the field never keeps stale attribution.

Payload's Local API skips field access checks by default, so the field hook
returns an ID or `null` on every write. Caller-supplied field values cannot
replace the attribution result.

## Debug diagnostics

Set `debug: true` to emit one debug-level entry for each attribution decision.
Every entry includes `plugin: "activity"`, the target's `entityType` and `slug`,
the write `operation`, and one of these outcomes:

- `attribution_applied` with the attributed `userId`
- `attribution_cleared` with a `no_user` or `foreign_auth_collection` reason

The plugin emits no diagnostics by default or while `enabled` is `false`. An
error from the configured Payload logger does not interrupt the write.

## Admin sidebar

The read-only sidebar field shows the admin user's configured title with an
email fallback and links to that user's document. The document's `updatedAt`
value appears beside the user as an absolute local timestamp. Unattributed
edits show `—`.

The component makes one request for an attributed user. While that request is
in flight, it shows only the timestamp. A failed request or deleted user falls
back to the stored user ID. It has no spinner, relative-time timer, or animated
loading state.

## Disabled mode

`enabled: false` keeps the field in the schema, hides it in Admin, and preserves
the stored value. A new document starts with `null`. This avoids schema churn
when attribution is paused.

## Development

Run the repository validation gates from the workspace root with `pnpm ready`.

## License

MIT. See [LICENSE](LICENSE).
