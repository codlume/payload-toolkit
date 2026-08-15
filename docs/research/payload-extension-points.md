# Payload extension points for generated media metadata

Research for [Research Payload extension points for generated media metadata](https://github.com/codlume/payload-toolkit/issues/11).

## Scope and evidence baseline

This note was researched on 2026-08-16 against Payload **3.88.0**, the current npm/GitHub release at the time. Source-code observations are pinned to release commit [`fea6f8a47a50ff1330d8a5071b43e7dcffb97b22`](https://github.com/payloadcms/payload/tree/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22); the package declares Node `^18.20.2 || >=20.9.0` ([package manifest](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/package.json#L1-L4), [engines](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/package.json#L154-L159)).

The labels below matter:

- **Documented** means Payload's public documentation promises the behavior.
- **Source observation** means Payload 3.88.0 implements the behavior, but its exact ordering or shape is not explicitly promised by the public docs. It must be covered by compatibility tests before widening the supported Payload range.
- **Recommendation** is the design conclusion for this plugin.

## Decision

Build the BlurHash integration as a **plain Payload config plugin** which immutably transforms only the configured upload collections and adds one stored text field. Put ownership enforcement, generation, and preview configuration on that field. Do not add a collection, endpoint, background job, storage fetcher, or separate logger package.

The plugin should generate from the effective upload on `create` and file-replacing `update`, synchronously in the field's `beforeChange` hook. Read the bytes from `req.file.data`, or from `req.file.tempFilePath` when Payload is configured to use temporary files. Gate on the post-processing `data.mimeType`, not the filename or the request's original MIME value. Preserve the existing hash when an update has no effective file; clear it when a new file is unsupported, animated, removed, or generation fails.

Initially support `payload >=3.88.0 <4` and test against the lowest supported version. Payload v4 must be an explicit compatibility review because this design relies on a 3.88 upload/hook ordering that is visible in source, not documented as a stable sequencing contract.

## Plugin shape and collection transformation

**Documented.** Payload's stable plugin contract is simply `(config) => config`; Payload calls plugins after incoming-config validation and before defaults and sanitization. The stable plain-function form is described as permanent. The newer `definePlugin` helper is recommended for published plugins, but the entire advanced API—including `definePlugin`, `slug`, `order`, and cross-plugin options—is explicitly experimental ([plugin API](https://payloadcms.com/docs/plugins/plugin-api), [pinned source documentation](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/plugins/plugin-api.mdx#L9-L37), [plugin execution phase](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/plugins/overview.mdx#L101-L105)). Official examples transform collections with `map`, spread the collection, preserve its fields, and append the generated field ([official plugin example](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/plugins/overview.mdx#L107-L154)).

**Recommendation.** Use the permanent plain `Plugin` contract. This plugin needs neither explicit ordering nor cross-plugin communication, so the experimental API buys no useful behavior. Its public options can remain small:

```ts
type BlurHashPluginOptions = {
  collections: string[]
  debug?: boolean // default false
  enabled?: boolean // default true
}
```

Use a fixed plugin-owned field name (the specification should settle `blurHash` versus `blurhash`) rather than exposing a field-name option in v1. Build a `Set` from `collections`, validate all slugs once, then map `config.collections`, returning untouched collection objects for non-targets and shallow copies with an appended field for targets. The transform must preserve every existing collection property and field.

Do not modify `upload`, do not replace collection hooks, and do not alter collection access. A field-local implementation is deeper and creates fewer ordering conflicts than injecting multiple collection hooks.

## Configuration validation and disabled behavior

**Documented.** Upload collections opt in with `upload: true` or an upload options object ([uploads overview](https://payloadcms.com/docs/upload/overview), [pinned docs](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/upload/overview.mdx#L28-L42)). Payload itself rejects duplicate data-bearing field names during config sanitization ([source observation](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/fields/config/sanitize.ts#L301-L311)), but that later error cannot explain which plugin introduced the collision.

**Recommendation.** When `enabled === false`, return the incoming config immediately and add no field, hook, or component, matching the early-return pattern used by the first-party Multi-Tenant plugin ([first-party example](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-multi-tenant/src/index.ts#L22-L27)). Otherwise, fail during plugin configuration with one actionable error that reports all of:

- duplicate slugs in the option array;
- configured slugs absent from `config.collections`;
- configured collections whose raw `upload` value is falsy;
- a top-level data-bearing field already using the plugin field name.

Payload's own plugins show both disabled conventions: some remove all plugin effects, while MCP retains schema to keep migrations consistent and Cloud Storage exposes `alwaysInsertFields` for the same reason ([MCP source](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-mcp/src/index.ts#L78-L84), [Cloud Storage docs](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/upload/storage-adapters.mdx#L462-L470)). The confirmed v1 requirement chooses the former. Consequently, changing `enabled` across deployed environments changes the database schema and must go through the application's normal migration process; `enabled` is a configuration switch, not a runtime feature flag.

## Upload lifecycle and the generation hook

### Public extension point

**Documented.** Field hooks receive the collection, operation, incoming data, original document, current/previous field value, sibling data, and a `req` object (mocked for Local API calls). A field `beforeChange` hook can replace the value which will be saved ([field hooks](https://payloadcms.com/docs/hooks/fields), [pinned hook arguments](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/hooks/fields.mdx#L37-L85), [beforeChange](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/hooks/fields.mdx#L119-L144)). Payload also documents `req.file` as the place to modify an uploaded filename in `beforeOperation`, establishing uploaded file access through the hook request ([upload hook example](https://payloadcms.com/docs/upload/overview#custom-filename-via-hooks)).

**Recommendation.** Put generation in the plugin field's `beforeChange` hook. The hook logic should be:

1. If there is no effective new file, return the previous/current persisted value. If the upload is explicitly removed, return `null`.
2. Read the normalized `data.mimeType` and allow only the supported static raster MIME values. Unsupported or animated new content returns `null`; this prevents an old hash from describing a replacement file.
3. Read the effective bytes from `req.file.tempFilePath` when present, otherwise `req.file.data`.
4. Decode, aggressively downsample, convert to RGBA, and encode the BlurHash in the same hook. The decoder/encoder parameters are a separate implementation decision, but all work must finish before returning.
5. Catch decoding/encoding errors, log a warning without image bytes or sensitive paths, return `null`, and let the upload continue.

### Why `beforeChange` has the right input

**Source observation.** In Payload 3.88.0, both create and update call `generateFileData` before field `beforeChange`. On create, file preparation is followed by field `beforeValidate`, collection `beforeValidate`, collection `beforeChange`, and finally field `beforeChange`; only then does Payload write the local file and create the database record ([create operation](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/create.ts#L158-L244), [local write](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/create.ts#L274-L284)). Update-by-ID also prepares the file before entering document hooks ([update-by-ID](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/updateByID.ts#L182-L211)); update then runs field `beforeValidate`, collection `beforeValidate`, local file writing, collection `beforeChange`, and field `beforeChange` ([update document](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/utilities/update.ts#L190-L278)).

`generateFileData` begins with `req.file`, applies configured crop/resize/format processing, derives normalized upload metadata, replaces the in-memory `req.file.data` with the effective main-file buffer, or rewrites the temporary file in place, then merges `mimeType`, dimensions, file size, and filename into the incoming data ([input and transform selection](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/generateFileData.ts#L75-L109), [normalized MIME](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/generateFileData.ts#L225-L278), [effective bytes](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/generateFileData.ts#L347-L381), [metadata merge](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/generateFileData.ts#L419-L433)). Therefore a field hook sees the pixels Payload intends as the main stored image, including crop/format edits, instead of hashing an unprocessed original.

There is an important update asymmetry: local update writes the new file before `beforeChange`, whereas create writes it after. The plugin's confirmed best-effort policy (catch and clear instead of throwing) avoids turning a metadata-generation failure into a partially advanced update. This behavior should be an integration test, not treated as a cross-version guarantee.

### Detecting new or replaced media

**Source observation.** `req.file` is absent when an update has no new/reprocessed file; `generateFileData` returns without file work in that case. It can also rehydrate an existing local or remote file when an editor applies crop/resize/focal edits, so those pixel-changing edits reach the same hook path ([re-upload detection and retrieval](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/generateFileData.ts#L113-L163)). Local API `create` and `update` explicitly assign their `file`/`filePath` input to `req.file` before running the operation ([create](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/local/create.ts#L211-L225), [update](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/local/update.ts#L250-L265)).

Use `req.file` presence as the work trigger, not a comparison of filenames or document timestamps. Use `data.mimeType` for eligibility because it is the post-processing value; extensions are neither authoritative nor sufficient to identify animation.

## File bytes across storage arrangements

Payload's exported `File` type contains `data: Buffer`, `mimetype`, `name`, `size`, and an optional `tempFilePath`; the type explicitly states that `data` is empty when temporary-file mode is enabled ([request type](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/types/index.ts#L94-L124), [file type](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/types.ts#L323-L348)). Payload documents `useTempFiles` as the memory-saving mode for large/many uploads ([upload options](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/upload/overview.mdx#L121-L140)).

The supported byte sources are therefore:

| Upload path | Hook input | Plugin behavior |
| --- | --- | --- |
| REST/Admin multipart, in memory | `req.file.data` | Decode the effective buffer. |
| Local API `file` or `filePath` | `req.file` populated by the Local API | Same logic as REST. |
| Payload `useTempFiles: true` | empty `data`, populated `tempFilePath` | Decode/read from the temporary path; Payload cleans it only after document hooks complete ([create cleanup](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/create.ts#L432-L451), [update cleanup](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/updateByID.ts#L230-L264)). |
| Official Cloud Storage server upload | same `req.file` before the adapter's `afterChange` upload | Generate before the cloud object is written; do not fetch it back. |
| Official Cloud Storage `clientUploads` | Payload calls the configured storage handler, follows a redirect if needed, and constructs `req.file.data` from the returned response | Same buffer path, with the memory caveat below. |

**Source observation.** Multipart parsing assigns the standard upload to `req.file`. For a first-party client upload, Payload retrieves the already-uploaded object through the collection handler and buffers the response into `req.file.data` before the collection operation ([request parsing](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/utilities/addDataAndFileToRequest.ts#L33-L60), [client-upload retrieval](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/utilities/addDataAndFileToRequest.ts#L60-L119)). The first-party Cloud Storage plugin likewise preserves `req.file` for nested work and builds its upload input from that request/context data ([preservation hook](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-cloud-storage/src/hooks/preserveFileData.ts#L1-L15), [incoming files](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-cloud-storage/src/utilities/getIncomingFiles.ts#L10-L34)).

Constraints:

- Official `clientUploads` still produces an in-memory buffer on the Payload request after downloading the object. BlurHash does not add that buffering, but decoding can add peak memory. Downsample immediately and never retain the source buffer beyond the hook.
- Custom adapters or external metadata-only updates that bypass Payload's standard `file` contract provide no bytes. Treat those as “no new file”; supporting them would require an explicit adapter API and is out of scope for v1.
- Temporary paths and exact hook ordering are source-level contracts. Test in-memory, temp-file, local, official server-upload, and official client-upload paths.
- Do not read `staticDir`, the document URL, or a cloud URL in normal generation. That duplicates access-control/storage concerns and races the storage lifecycle.

## Plugin-owned persistence and API exposure

**Documented.** A normal collection field is stored and participates in the automatically generated Local, REST, and GraphQL APIs ([collection docs](https://payloadcms.com/docs/configuration/collections), [pinned statement](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/configuration/collections.mdx#L9-L13)). `admin.readOnly` only disables editing in Admin and “has no effect on the API whatsoever” ([field admin options](https://payloadcms.com/docs/fields/overview#admin-options), [pinned docs](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/fields/overview.mdx#L618-L633)). Field access `create` and `update` can discard submitted values, while leaving `read` allowed exposes the field in results ([field access](https://payloadcms.com/docs/access-control/fields), [pinned behavior](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/access-control/fields.mdx#L58-L95)).

**Recommendation.** Add a nullable, non-localized, non-virtual `text` field with:

- `admin.readOnly: true`;
- `access.create: () => false` and `access.update: () => false`;
- no restrictive `read` access and no `hidden` flag;
- `beforeValidate` ownership enforcement;
- `beforeChange` generation;
- the custom Admin field component.

Access control alone is insufficient for strict ownership because Local API operations default to `overrideAccess: true` ([Local API docs](https://payloadcms.com/docs/local-api/access-control), [create source default](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/collections/operations/local/create.ts#L200-L205)). Add a field `beforeValidate` hook that ignores the incoming field value and returns `null` on create or `originalDoc[fieldName]` on update. Then let the later field `beforeChange` hook return the plugin-generated value. This blocks ordinary REST, GraphQL, Admin, and Local API callers from supplying the field even when access is overridden.

**Source observation.** Payload 3.88.0 runs field `beforeValidate` hooks, then field access/fallback handling ([source](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/fields/hooks/beforeValidate/promise.ts#L275-L342)); later it runs the field `beforeChange` hook and applies its returned value before validation/storage ([source](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/fields/hooks/beforeChange/promise.ts#L126-L165)). The two-hook design depends on that ordering and needs an integration test with both `overrideAccess: false` and the Local API default.

The field will be returned by all enabled collection API surfaces unless a caller's `select` excludes it or collection/document read access denies the document. No custom endpoint, resolver, or `afterRead` hook is needed.

## Admin preview

**Documented.** A field can replace its Admin `Field` with a custom Server or Client Component referenced through a component path; Payload generates an import map for those paths ([custom components](https://payloadcms.com/docs/custom-components/overview), [component paths](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/custom-components/overview.mdx#L31-L66), [import map](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/custom-components/overview.mdx#L143-L155)). The first-party SEO plugin uses the published-package path form `@payloadcms/plugin-seo/client#PreviewComponent`, passes serializable client props, and exposes the component from a `./client` package subpath ([field config](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-seo/src/fields/Preview/index.ts#L25-L48), [client barrel](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-seo/src/exports/client.ts#L1-L5), [package exports](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-seo/package.json#L32-L53)).

**Recommendation.** Set the stored text field's `admin.components.Field` to the plugin package's `./client` named export, for example `@scope/payload-blurhash/client#BlurHashField`. The client component should read the actual form field value using Payload UI's field hook and render:

- a fixed-size, static canvas decoded from the saved BlurHash;
- the string in selectable read-only text;
- a clear empty/unavailable state.

Render only when the hash changes, cap the canvas dimensions, and do not animate or continuously repaint. Keeping the preview on the stored field avoids a second UI-only field and guarantees the UI displays the exact API value. Export the client component from a browser-safe subpath; the root/server entry must never import it eagerly. Follow the first-party dependency split: the SEO package depends on `@payloadcms/ui` and peers `payload`, `react`, and `react-dom` ([manifest](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-seo/package.json#L70-L85)).

## Logging and the `debug` option

**Documented.** Payload uses Pino, exposes its logger on the Payload instance, and defaults to pretty stdout; applications control log level/destination in Payload config ([logger docs](https://payloadcms.com/docs/configuration/overview#logger), [pinned docs](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/configuration/overview.mdx#L280-L318)). The first-party Import/Export plugin has a `debug?: boolean` option and conditionally emits structured `req.payload.logger.debug({ msg, ... })` calls ([option](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-import-export/src/types.ts#L285-L296), [usage](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/plugin-import-export/src/import/createImport.ts#L79-L108)).

**Recommendation.** Keep a tiny private logger adapter in this package, backed by `req.payload.logger`; a separate logger package has no useful contract yet. Prefix or structurally tag every entry with the plugin name and collection slug. Behavior:

- `debug: false` (default): no lifecycle chatter; warn once per failed/skipped generation as appropriate.
- `debug: true`: emit structured start/skip/success/timing details with `logger.debug`.
- Never log the source buffer, BlurHash pixel data, full temporary paths, or whole documents.

`debug: true` enables the calls but Pino will only print `debug` entries if the host logger level allows them. Document that users who want terminal debug output must also configure Payload's logger with `level: 'debug'`. Do not silently promote debug events to `info`, and do not mutate the application's logger configuration from a plugin.

Warnings/errors are operational events and remain at `warn`/`error` independently of the debug option. Because the confirmed failure policy is non-fatal, use `warn` for a supported image that could not be decoded/encoded and reserve `error` for an unexpected plugin invariant. Include the error object in the structured event, without input bytes.

## Sharp and decoder boundary

**Documented.** Payload exposes an optional app-provided `sharp` module in config and requires it for Payload image resizing; `create-payload-app` configures it by default ([config option](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/configuration/overview.mdx#L75-L104), [image resizing docs](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/docs/upload/overview.mdx#L185-L193), [config type](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/config/types.ts#L1476-L1489)). Payload 3.88 recognizes JPEG, PNG, WebP, and AVIF among its resizable formats, but also recognizes GIF/TIFF; this list is a Payload implementation detail, not the plugin's supported-format policy ([source](https://github.com/payloadcms/payload/blob/fea6f8a47a50ff1330d8a5071b43e7dcffb97b22/packages/payload/src/uploads/canResizeImage.ts#L1-L7)).

**Recommendation.** Reuse `req.payload.config.sharp` as the decode/downsample boundary rather than installing and initializing an unrelated image stack. The implementation/specification ticket must decide whether absence of `config.sharp` is a startup configuration error or a per-upload warning; fail-fast is clearer because the plugin cannot fulfill its core capability without a decoder. Avoid accepting a generic “processor” option in v1 unless tests expose a real need.

Format eligibility remains plugin-owned: JPEG, PNG, WebP, and AVIF only, with decoded metadata confirming a single page/frame. SVG, GIF, TIFF, JXL, PDFs, video, audio, and multi-page/animated variants are unsupported. The decoder—not only MIME—must enforce the animation rule because APNG and animated WebP/AVIF can share the same MIME type as static files.

## Compatibility and acceptance tests implied by this research

The first release should declare and verify these boundaries:

1. Payload `>=3.88.0 <4`; Node aligned to Payload's engine range. Use Payload 3.88.0 as the minimum test lane.
2. Stable plain config-plugin API only. Do not adopt experimental `definePlugin` until it supplies a concrete need or becomes stable.
3. In-memory multipart, `useTempFiles`, Local API `file`, local storage, official Cloud Storage server uploads, and one official `clientUploads` adapter.
4. Create, replace, update-without-file, crop/format reprocessing, remove-file, unsupported MIME, animated raster, decoder failure, and generation failure.
5. Ownership attempts through REST/GraphQL with access enabled and Local API with its default `overrideAccess: true`.
6. Returned value through Local, REST, and GraphQL, including selection behavior.
7. Admin import-map generation, saved-value preview, empty state, read-only behavior, and no continuous repaint.
8. Existing collection fields/config preserved; missing, non-upload, duplicate option, and field-collision errors are exact and actionable.
9. Disabled mode adds nothing, plus a migration test/documentation note showing the field is a schema change when toggled.
10. Debug off/on with a logger spy; verify no buffers, documents, hashes' decoded pixels, or full temporary paths appear in logs.

## Items this research adds to the plugin specification

The original idea is sufficient once the following details are made explicit:

- Require/configure Sharp, or explicitly define the no-Sharp behavior.
- Clear stale hashes on replacement failure, unsupported/animated replacement, and file removal; preserve on metadata-only updates.
- Document that `debug: true` also needs Payload logger level `debug` to be visible.
- Document the migration consequence of `enabled: false` adding no schema.
- State that custom storage flows which bypass Payload's standard `req.file` contract are unsupported in v1.
- Pin the first compatibility range to Payload 3.88.x behavior and make the upload/hook ordering an integration-test contract.
- Keep client exports separate from the root/server entry so published plugin consumers do not pull browser code into Payload config.
