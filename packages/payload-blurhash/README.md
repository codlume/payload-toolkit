# Payload BlurHash

## Unreleased

`@codlume/payload-blurhash` is private and has not been published. The package
name and Codlume npm scope are provisional and are not claimed or reserved.
After a future release, the intended installation command will be:

```sh
pnpm add @codlume/payload-blurhash
```

The host Payload application must also provide compatible Payload, Payload UI,
React, React DOM, and Sharp installations. The plugin uses the Sharp instance
passed to Payload instead of installing or configuring its own decoder.

## Compatibility

- Payload >=3.88.0 <4
- Node >=22.12.0 <23 || >=24.0.0 <25
- React and React DOM 19
- Sharp 0.35.3 in the currently tested application lanes

Payload 4, Node 20, and versions outside the verified lanes are not supported.

## Configuration

Pass the host's Sharp instance to Payload and add the plugin once. The
`collections` option is required and accepts one or more upload collection
slugs; generated Payload types provide slug completion.

```ts
import { blurHashPlugin } from "@codlume/payload-blurhash";
import { buildConfig, type CollectionConfig } from "payload";
import sharp from "sharp";

const Media: CollectionConfig = {
  slug: "media",
  upload: true,
  fields: [],
};

export default buildConfig({
  collections: [Media],
  plugins: [blurHashPlugin({ collections: ["media"] })],
  sharp,
});
```

Only `collections` is required. Generation and the Admin preview are enabled by
default, diagnostics are disabled, the field is named `blurHash`, transparent
pixels are flattened onto opaque white, and BlurHash detail is fixed at 4 × 3
components. All RGB channels must be integers from 0 through 255. Limit
overrides must be positive safe integers.

| Option                  | Type                                  | Default                             |
| ----------------------- | ------------------------------------- | ----------------------------------- |
| `collections`           | `UploadCollectionSlug[]`              | Required; no default                |
| `enabled`               | `boolean`                             | `true`                              |
| `debug`                 | `boolean`                             | `false`                             |
| `fieldName`             | `string`                              | `"blurHash"`                        |
| `alphaBackground`       | `{ r: number; g: number; b: number }` | `{ r: 255, g: 255, b: 255 }`        |
| `limits.concurrency`    | `number`                              | `1` on one processor; otherwise `2` |
| `limits.maxInputBytes`  | `number`                              | `26_214_400` (25 MiB)               |
| `limits.maxInputPixels` | `number`                              | `40_000_000`                        |
| `limits.maxInputSide`   | `number`                              | `16_384`                            |
| `limits.timeoutSeconds` | `number`                              | `10`                                |

Configuration errors are reported together at startup. The plugin rejects
missing, duplicate, and non-upload collection slugs; unsafe, reserved, or
colliding field names; duplicate plugin registration; and enabled generation
without `config.sharp`.

## Field and API behavior

Each configured upload collection receives one nullable, stored text field.
The field is plugin-owned: it is read-only in Admin, and values supplied through
Admin, REST, GraphQL, or the Local API cannot overwrite it. Ordinary Payload
document access and field selection continue to govern reads, and the value is
available through Payload's Local, REST, and GraphQL APIs without a custom
endpoint.

Generation runs synchronously for a new or replaced file. A successful eligible
upload stores its new 28-character BlurHash. Metadata-only updates preserve the
current value. Replacements that are skipped or fail, and removal of the current
file, store `null` so a stale placeholder never describes different or absent
pixels. Placeholder failure is fail-open and does not reject the media write.

## Supported media

The plugin accepts newly uploaded or replaced static JPEG, PNG, WebP, and AVIF
images. It compares the normalized declared MIME type, bounded container
inspection, and Sharp metadata rather than trusting a filename extension.
Payload's effective post-processing bytes are used for in-memory, temporary-file,
Local API, and official Cloud Storage server or client upload paths.

Before encoding, Sharp applies EXIF orientation, converts to 8-bit sRGB,
composites transparency against the configured opaque background, and downsizes
within 32 × 32 pixels while preserving aspect ratio. Malformed or mismatched
containers, unsupported types, APNG, animated WebP, AVIF sequences, multi-image
AVIF, and inputs outside the resource limits produce no value.

## Resource limits

The defaults bound compressed input to 25 MiB, decoded input to 40 million
pixels, and either side to 16,384 pixels. Generation times out after 10 seconds.
One plugin-local queue is shared by every configured collection and permits one
active generation on a single available processor or two otherwise. Advanced
operators can explicitly supply positive overrides through `limits`.

## Logging and privacy

Expected `not_eligible` and `animated_input` skips are emitted only when
`debug: true`. Failures warn with stable codes: `type_mismatch`,
`malformed_container`, `input_too_large`, `decoder_unavailable`,
`decode_timeout`, `decode_failed`, or `encode_failed`. Decoder-unavailable
warnings are emitted once per affected format so other formats can continue.

Diagnostics use Payload's logger and include bounded lifecycle, collection,
stage, timing, MIME, byte-count, and dimension fields. They never include image
bytes, BlurHash values, filenames, full paths, decoded metadata, or documents.
Enabling debug diagnostics does not change the host logger level.

## Admin preview

The generated field renders a static preview and a selectable read-only value.
The canvas preserves the source aspect ratio inside a 288 × 180 CSS-pixel bound,
is decoded once at a small memoized resolution, and has no animation or repaint
loop. Valid, absent, and invalid stored values have distinct accessible states;
an invalid value remains available for inspection without breaking the form.

## Disabled mode and existing media

`enabled: false` keeps the stored field and its normal API reads while hiding it
in Admin and disabling generation. Metadata-only updates still preserve the
current value; replacement or removal clears it. Re-enabling affects only future
uploads and replacements. The plugin never migrates field names, regenerates
values, or backfills media that already exists.

## Development

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @codlume/payload-blurhash build
pnpm --filter @codlume/payload-blurhash test:unit
pnpm --filter @codlume/payload-blurhash test:build
pnpm test:pack
```

`test:pack` builds and inspects the packed contents, creates a real tarball, and
installs it in a temporary clean Payload consumer to verify runtime entries,
declarations, import-map resolution, and Payload initialization.

## License

MIT. See [LICENSE](LICENSE).
