# Payload Activity

## Unreleased

`@codlume/payload-activity` is private and has not been published. The package
name and Codlume npm scope are provisional and are not claimed or reserved.

## Compatibility

- Payload >=3.88.0 <4
- Node >=22.12.0 <23 or >=24.0.0 <25

## Configuration

Register the plugin once and list the collections that need edit attribution.
Generated Payload types provide completion for collection slugs.

```ts
import { activityPlugin } from "@codlume/payload-activity";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [
    { auth: true, fields: [], slug: "users" },
    { fields: [], slug: "posts" },
  ],
  plugins: [activityPlugin({ collections: ["posts"] })],
});
```

| Option        | Type               | Default            |
| ------------- | ------------------ | ------------------ |
| `collections` | `CollectionSlug[]` | Required           |
| `enabled`     | `boolean`          | `true`             |
| `debug`       | `boolean`          | `false`            |
| `fieldName`   | `string`           | `"lastModifiedBy"` |

Configuration errors are reported together at startup. The plugin rejects
missing, empty, duplicate, malformed, and unknown collection slugs. It also
rejects unsafe, reserved, or colliding field names, duplicate registration,
and an invalid admin user collection. The `debug` option is validated but this
package slice does not emit diagnostics yet.

## Attribution behavior

Each configured collection receives a nullable relationship to the admin user
collection. The field is read-only in Admin and denies direct create and update
access. An edit made by an admin user stores that user's ID. A write without a
user, or with a user from another auth collection, stores `null` so the field
never keeps stale attribution.

Payload's Local API skips field access checks by default, so the field hook
returns an ID or `null` on every write. Caller-supplied field values cannot
replace the attribution result.

## Disabled mode

`enabled: false` keeps the field in the schema, hides it in Admin, and preserves
the stored value. A new document starts with `null`. This avoids schema churn
when attribution is paused.

## Development

Run the repository validation gates from the workspace root with `pnpm ready`.

## License

MIT. See [LICENSE](LICENSE).
