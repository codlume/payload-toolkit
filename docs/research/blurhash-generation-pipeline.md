# Safe and efficient BlurHash generation pipeline

Research completed 2026-08-16 for [“Research a safe and efficient BlurHash generation pipeline”](https://github.com/codlume/payload-toolkit/issues/12).

## Decision

Use [`sharp`](https://sharp.pixelplumbing.com/) to identify, validate, orient, colour-convert, flatten, and downsample uploaded image bytes, then use Wolt's official [`blurhash`](https://www.npmjs.com/package/blurhash/v/2.0.5) TypeScript implementation to encode the resulting 8-bit RGBA pixels. The browser preview should use that package's decoder directly into a small canvas.

The v1 contract is deliberately narrow:

- accept one static raster image whose declared MIME type, container signature, and Sharp-decoded media type agree;
- support JPEG, PNG, WebP, and AVIF only;
- reject animation and multi-image inputs rather than silently hashing their first frame;
- generate synchronously only for a new or replaced upload;
- fail open for the media write: a skipped or failed generation stores `null`, never a stale hash;
- apply fixed, bounded work before the pure-JavaScript BlurHash encoder.

The exact pipeline defaults should be:

| Setting                       |                                        v1 default |
| ----------------------------- | ------------------------------------------------: |
| Maximum compressed input      |                       25 MiB (`26_214_400` bytes) |
| Maximum decoded input         |                                 40,000,000 pixels |
| Maximum width or height       |                                     16,384 pixels |
| Maximum input channels        |                                                 4 |
| Sharp failure sensitivity     |                               `failOn: 'warning'` |
| Sharp processing timeout      |                                        10 seconds |
| Simultaneous plugin pipelines |          `max(1, min(2, availableParallelism()))` |
| Downsample box                | 32 × 32, preserving aspect ratio, never enlarging |
| Resampling                    |   `lanczos3`, with Sharp's shrink-on-load enabled |
| Output pixels                 |                                   8-bit sRGB RGBA |
| Transparency background       |            opaque white (`#ffffff`), configurable |
| BlurHash components           |               X = 4, Y = 3, configurable together |
| Preview decode                |          32 pixels on the longest edge, punch = 1 |

The numeric resource limits are **project choices (inferences)**, not values prescribed by BlurHash or Sharp. They are conservative starting points for synchronous CMS uploads and should be exposed under one optional `limits` object, measured in the integration app, and revisited from production telemetry. The limits must not be silently relaxed.

## Versions and source baseline

This investigation used these current upstream releases and specifications:

- Sharp **0.35.3**, published 2026-07-01, commit [`1018449164723ba0203c1beffaba0e21f7829c18`](https://github.com/lovell/sharp/tree/1018449164723ba0203c1beffaba0e21f7829c18). It requires Node.js 20.9 or newer and libvips 8.18.3 or newer; see the [0.35.3 release](https://github.com/lovell/sharp/releases/tag/v0.35.3) and [package manifest](https://github.com/lovell/sharp/blob/1018449164723ba0203c1beffaba0e21f7829c18/package.json).
- libvips **8.18.3**, commit [`3664cfc5dc2c5661288f5bf5a85ccc51c64c1626`](https://github.com/libvips/libvips/tree/3664cfc5dc2c5661288f5bf5a85ccc51c64c1626), dated 2026-06-08.
- Wolt `blurhash` **2.0.5**. The npm artifact was inspected on 2026-08-16; npm reported its registry record last modified 2024-10-28. The upstream TypeScript tree was at commit [`712a47f946b98c30097eb1ada086ea00b18681ec`](https://github.com/woltapp/blurhash/tree/712a47f946b98c30097eb1ada086ea00b18681ec), dated 2024-05-21.
- [PNG Third Edition](https://www.w3.org/TR/png-3/), W3C Recommendation of 2025-06-24.
- [WebP container specification](https://developers.google.com/speed/webp/docs/riff_container), last updated 2025-08-07.
- [AV1 Image File Format 1.2.0](https://aomediacodec.github.io/av1-avif/v1.2.0.html), AOM final deliverable of 2025-10-16.

Package tests should pin the exact Sharp and BlurHash versions. Published package ranges can be broader only after CI proves the supported matrix. Native decoder output can change on a Sharp/libvips upgrade, so dependency updates require fixture regeneration review rather than an automatic snapshot update.

## Why these libraries

### BlurHash encoder and decoder

Choose Wolt's `blurhash` package rather than another port or a local implementation.

- It is the TypeScript implementation linked by the algorithm owner, includes `encode`, `decode`, and `isBlurhashValid`, and is MIT-licensed. Its [public API](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/TypeScript/README.md#api) operates on RGBA `Uint8ClampedArray` data and can render decoded pixels directly to canvas.
- The [official encoder source](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/TypeScript/src/encode.ts) enforces 1–9 components on each axis, converts the R/G/B bytes from sRGB to linear values, and deliberately advances in four-byte pixels without using the alpha byte.
- The [algorithm specification](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/Algorithm.md) stores the average colour as 24-bit sRGB and encodes the remaining components lossily.

The ignored alpha byte is important: feeding unflattened RGBA pixels would encode hidden RGB values under transparent pixels. A deterministic opaque background must therefore be chosen before encoding.

### Decoder and image pipeline

Choose Sharp rather than a pure-JavaScript image decoder or shelling out to an image command.

- Sharp accepts buffers for every v1 format and exposes format, media type, dimensions, page count, alpha, profile, orientation, and HEIF compression through [`metadata()`](https://sharp.pixelplumbing.com/api-input/#metadata).
- It exposes explicit untrusted-input controls: [`failOn`, `limitInputPixels`, `limitInputChannels`, sequential access, and page selection](https://sharp.pixelplumbing.com/api-constructor/#new).
- It can orient, colour-convert, alpha-composite, resize, and return [raw 8-bit RGB/RGBA pixels](https://sharp.pixelplumbing.com/api-output/#raw) without an intermediate encoded thumbnail.
- Sharp/libvips performs native, demand-driven image processing. Sharp documents the interaction between the libuv image queue and libvips' per-image threads in its [performance guide](https://sharp.pixelplumbing.com/performance/).

Do not spawn `convert`, `ffmpeg`, or another process. Do not pass a path, URL, original filename, or arbitrary stream type into Sharp; pass only the already-buffered upload bytes. That keeps shell injection, path traversal, and SSRF outside this module's interface.

## Exact eligible-format matrix

The request MIME type is a cheap allow-list gate, not proof of content. The byte signature/container and Sharp's decoded metadata are the authoritative checks. A candidate is eligible only when all columns in its row agree.

| Accepted declared MIME | Initial byte/container check                            | Required Sharp metadata                                                        | Static-only check                                                                           | Result |
| ---------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| `image/jpeg`           | Starts `FF D8 FF`                                       | `format === 'jpeg'` and `mediaType === 'image/jpeg'`                           | JPEG primary image accepted; embedded thumbnail or gain map is not treated as another frame | Accept |
| `image/png`            | Exact 8-byte PNG signature                              | `format === 'png'` and `mediaType === 'image/png'`                             | No valid `acTL` chunk before the first `IDAT`                                               | Accept |
| `image/webp`           | `RIFF`, bounded RIFF size, then `WEBP`                  | `format === 'webp'` and `mediaType === 'image/webp'`                           | No VP8X animation flag, `ANIM`, or `ANMF`; `pages` absent or `1`                            | Accept |
| `image/avif`           | A bounded `ftyp` box containing `avif`; no `avis` brand | `format === 'heif'`, `mediaType === 'image/avif'`, and `compression === 'av1'` | `pages` absent or `1`; no `avis` brand                                                      | Accept |

The MIME spellings follow the [IANA image media-type registry](https://www.iana.org/assignments/media-types/media-types.xhtml#image) and the format specifications linked below.

Everything else is ineligible in v1. In particular:

- reject `image/apng`, `image/gif`, SVG, TIFF, HEIC/HEIF, PDF, JPEG XL, and generic `application/octet-stream`;
- do not accept aliases such as `image/jpg` or `image/x-png`; the registered forms keep the contract exact;
- ignore filename extensions entirely;
- normalize only case and an optional MIME parameter suffix before exact comparison; do not use `startsWith('image/')`;
- treat a MIME/signature/decoder disagreement as `type_mismatch`, not as a reason to trust whichever value is most convenient.

Sharp 0.35 derives `mediaType` from the decoder actually selected and distinguishes AV1-compressed HEIF as `image/avif` from HEVC-compressed HEIF as `image/heic`; see its pinned [metadata implementation](https://github.com/lovell/sharp/blob/1018449164723ba0203c1beffaba0e21f7829c18/src/metadata.cc#L153-L196). That is why AVIF expects Sharp's internal `heif` format plus both `mediaType: image/avif` and `compression: av1`.

**Project choice (inference):** require all three layers to agree, even though the decoder is capable of safely identifying a supported file whose client MIME is missing or wrong. This avoids quietly normalizing malformed uploads and gives the plugin a small, auditable decoder surface.

## Animation and multi-image detection

Never set Sharp's `animated: true` or `pages: -1`. The pipeline wants one static raster and must avoid allocating a vertically stacked multi-frame image.

### PNG / APNG

Sharp 0.35.3/libvips 8.18.3 uses a [static libspng-based PNG loader](https://github.com/libvips/libvips/blob/3664cfc5dc2c5661288f5bf5a85ccc51c64c1626/libvips/foreign/spngload.c) and does not expose APNG pages. Relying on `metadata.pages` would therefore hash the APNG fallback frame and mislabel an animation as static.

Parse the PNG chunk envelope before Sharp:

1. verify the 8-byte signature;
2. walk bounded chunks using big-endian unsigned length, four-byte type, data, and four-byte CRC positions;
3. reject on an out-of-bounds length or more than 4,096 chunks;
4. reject as animated immediately on `acTL`;
5. stop at the first `IDAT` if no `acTL` was found.

The W3C specification says [`acTL` declares an animated PNG and must precede the first `IDAT`](https://www.w3.org/TR/png-3/#11acTL). `num_frames = 1` is still a valid animation declaration, so check presence, not a frame-count threshold. This guard also prevents the moderation ambiguity described in the [APNG media-type security considerations](https://www.w3.org/TR/png-3/#image-apng), where a non-APNG tool sees only the unrelated fallback image.

The small parser identifies structure only; it does not replace Sharp's CRC and pixel-data validation.

### WebP

Parse the RIFF chunk envelope with little-endian sizes and padding, using checked arithmetic and the same 4,096-entry cap. Reject if any of these is present:

- the animation bit (`0x02`) in the VP8X feature byte;
- an `ANIM` chunk;
- an `ANMF` chunk;
- Sharp `metadata.pages > 1`.

The WebP specification defines the [animation flag and `ANIM`/`ANMF` chunks](https://developers.google.com/speed/webp/docs/riff_container#animation). Rejecting a stray animation chunk even when the flag is unset is a **conservative project inference**: the WebP spec tells conforming readers to ignore that inconsistency, but v1 should not derive a static placeholder from an ambiguous container. libvips' loader records the original animation frame count as `n-pages`; see its pinned [WebP loader](https://github.com/libvips/libvips/blob/3664cfc5dc2c5661288f5bf5a85ccc51c64c1626/libvips/foreign/webp2vips.c#L430-L526).

### AVIF

Parse the bounded ISO Base Media File Format `ftyp` box rather than searching arbitrary bytes for a word:

1. support both normal and 64-bit box sizes, reject sizes outside the 25 MiB buffer;
2. collect the major brand and compatible brands from `ftyp`;
3. require `avif` and reject `avis`;
4. after Sharp metadata, reject `pages > 1` (this also excludes image collections).

The AVIF specification defines `avif` for [image items and collections](https://aomediacodec.github.io/av1-avif/v1.2.0.html#avif-image-and-image-collection-brand) and `avis` for [image sequences](https://aomediacodec.github.io/av1-avif/v1.2.0.html#avif-image-sequence-brands). Conforming AVIF files must list `avif` or `avis` in `ftyp`. An AV1 image sequence lives in a track, while an image item is still present as a fallback, so decoding only the primary item is not sufficient animation detection.

Sharp/libvips reports multiple top-level HEIF images as pages and identifies the primary image; see the pinned [HEIF loader](https://github.com/libvips/libvips/blob/3664cfc5dc2c5661288f5bf5a85ccc51c64c1626/libvips/foreign/heifload.c#L797-L897). Auxiliary alpha, depth, thumbnails, and gain-map items should not count as top-level pages and remain eligible.

**Residual limitation:** malformed AVIF that contains a sequence but intentionally omits the required `avis` brand may escape a lightweight `ftyp` guard if its decoder exposes only the fallback item. Fully validating arbitrary ISOBMFF tracks would require a second container parser and is not justified for v1. Strict Sharp decoding, the byte/pixel/time limits, and treating only conforming `avif` files as supported define the v1 boundary.

## Pixel-normalization and encoding pipeline

The deep server-side function should conceptually perform the following steps. The pseudocode names behavior, not a required public API:

```ts
async function generateBlurHash(input: {
  bytes: Buffer;
  declaredMime: string;
  alphaBackground: RGB;
  components: { x: number; y: number };
}): Promise<GenerationResult> {
  // 1. MIME, byte-size, signature, container, and animation preflight.
  // 2. Enter the plugin-local bounded-concurrency gate.
  const image = sharp(input.bytes, {
    failOn: "warning",
    limitInputChannels: 4,
    limitInputPixels: 40_000_000,
    pages: 1,
    sequentialRead: true,
    unlimited: false,
  });

  const metadata = await image.metadata();
  // 3. Validate decoded format/mediaType/compression/pages/dimensions.
  // 4. Compute exact integer target dimensions inside 32x32 from
  //    metadata.autoOrient, using scale <= 1 and a minimum of 1px.

  const { data, info } = await image
    .pipelineColourspace("srgb")
    .autoOrient()
    .flatten({ background: input.alphaBackground })
    .resize({
      width: targetWidth,
      height: targetHeight,
      fit: "fill",
      kernel: "lanczos3",
      fastShrinkOnLoad: true,
    })
    .toColourspace("srgb")
    .ensureAlpha(1)
    .raw({ depth: "uchar" })
    .timeout({ seconds: 10 })
    .toBuffer({ resolveWithObject: true });

  // 5. Require info.channels === 4 and data.length === width * height * 4.
  return ok(
    encode(asClampedView(data), info.width, info.height, input.components.x, input.components.y),
  );
}
```

Implementation details:

- Use `metadata.autoOrient.width` and `.height` when computing the target. Sharp documents that normal metadata dimensions do not apply orientation, while [`autoOrient()` rotates/flips and removes the orientation tag](https://sharp.pixelplumbing.com/api-operation/#autoorient).
- Calculate `scale = min(1, 32 / max(orientedWidth, orientedHeight))`, then independently round each scaled dimension and clamp it to at least 1. Passing both dimensions makes the output size explicit.
- Preserve the whole image. Do not crop to 32 × 32; a placeholder should have the source aspect ratio.
- Use Lanczos3 and Sharp's default shrink-on-load. Sharp documents that shrink-on-load improves JPEG/WebP downsizing performance and can introduce only a slight moiré/rounding difference; the [resize API](https://sharp.pixelplumbing.com/api-resize/#resize) identifies Lanczos3 as the default reduction kernel.
- Explicitly use sRGB for both the processing and output colourspaces. This makes the configured alpha background an sRGB colour as well as producing the samples BlurHash expects. Sharp's [colour API](https://sharp.pixelplumbing.com/api-colour/#pipelinecolourspace) distinguishes the pipeline colourspace from the final output colourspace. Raw non-greyscale output is RGB/RGBA, left-to-right and top-to-bottom, with no padding.
- Add opaque alpha after flattening because the official encoder requires four bytes per pixel even though it ignores the fourth byte. Construct a `Uint8ClampedArray` view using the Buffer's `buffer`, `byteOffset`, and `byteLength`; assert the expected length first.
- Do not encode the original full-resolution pixels. Wolt says fine detail is discarded, recommends scaling before encoding, and commonly decodes placeholders at 32 or 20 pixels wide; see its [performance guidance](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/Readme.md#how-fast-is-encoding-decoding).

### Orientation

Hash the displayed orientation, not the storage orientation. `.autoOrient()` handles all EXIF rotation and mirroring variants. For HEIF/AVIF, libvips applies HEIF transforms and removes EXIF orientation to avoid double rotation; the same high-level Sharp call remains safe.

### Colour

Hash normalized 8-bit sRGB samples because that is the BlurHash algorithm's input space. Let Sharp honor a valid embedded ICC profile and convert to its sRGB processing/output space. Invalid profiles should become a generation failure under `failOn: 'warning'`, not a reason to interpret arbitrary bytes as sRGB silently.

HDR/wide-gamut inputs are reduced to the SDR sRGB placeholder. This is a **project inference**: BlurHash stores sRGB coefficients and has no HDR metadata channel. The placeholder is an approximation; it is not a colour-managed substitute for the source.

### Alpha

BlurHash has no transparency channel and its official encoder ignores alpha. Flatten before extracting raw pixels. Default to opaque white, but add a plugin option such as `alphaBackground` because a transparent logo designed for a dark page needs a different result. Validate this option at startup and normalize it to a fixed 8-bit RGB triple.

Changing the configured background later does not rewrite existing documents. That operational consequence must be documented alongside the option.

### Components and hash length

Default to 4 × 3, Wolt's stated usual balance between detail and length; see [“How do I pick the number of X and Y components?”](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/Readme.md#how-do-i-pick-the-number-of-x-and-y-components). The hash length is `4 + 2xy`, so this default is 28 ASCII characters.

Expose one global `components: { x, y }` option and validate both as integers from 1 through 9 at configuration time. Do not automatically change component counts by aspect ratio in v1: fixed settings make field length, snapshots, caching, and regeneration behavior unsurprising. Collection-specific overrides can wait for evidence.

## Performance, memory, concurrency, and security

### Bound work at every layer

Apply checks in increasing cost order:

1. supported declared MIME;
2. compressed byte limit;
3. bounded signature/container parsing and animation rejection;
4. Sharp header metadata and decoded-format agreement;
5. oriented dimensions, channels, and page count;
6. one decoded/downsampled Sharp pipeline with a 10-second timeout;
7. BlurHash over no more than 1,024 RGBA pixels and 12 components by default.

Sharp's default pixel ceiling is 268,402,689 pixels and its documentation explicitly recommends `failOn: 'warning'` for untrusted input. v1 should lower the pixel ceiling to 40,000,000 and keep `unlimited: false`. The extra 16,384-per-axis check bounds extremely thin pathological images independently of total pixel count.

The 25 MiB compressed limit must be checked before constructing Sharp. This duplicates, but does not replace, a Payload collection upload limit. The plugin's outcome is `input_too_large` and `null`; whether Payload itself accepts the original media remains the host application's policy.

### Do not mutate Sharp process globals

Sharp's cache, libvips concurrency, block list, and SIMD switches are process-wide. A reusable Payload plugin must not call `sharp.cache(...)`, `sharp.concurrency(...)`, `sharp.block(...)`, `sharp.unblock(...)`, or change `UV_THREADPOOL_SIZE`; doing so would unexpectedly alter the host app and other plugins. Sharp documents these as [global properties](https://sharp.pixelplumbing.com/api-utility/).

Instead, use a plugin-local FIFO semaphore shared by all configured collections. Default it to one task on a one-core runtime and two tasks otherwise. This is a **project inference** intended to cap simultaneous decoder memory while retaining modest throughput. Put `concurrency` in the optional `limits` object so a deployment can tune it after measurement.

Sharp notes that libuv controls the number of images processed concurrently and libvips separately controls threads per image. The host may tune those process-wide facilities before startup, but the plugin should only report `sharp.versions`, queue time, and transform time when debug logging is enabled.

### Memory shape

The upload Buffer already exists at the Payload boundary. Avoid copying it before Sharp. The raw result is at most 32 × 32 × 4 = 4,096 bytes, and BlurHash encoding over that buffer is negligible relative to decode. libvips' demand-driven pipeline and format-specific shrink-on-load reduce intermediate work, but no in-process decoder can promise a strict resident-memory ceiling for every malicious compressed file. Pixel, byte, page, timeout, and concurrency limits are defense in depth, not a sandbox.

If the threat model later requires isolation from native decoder crashes or zero-days, move generation into a separately constrained worker process. That is out of scope for the synchronous v1 design.

### Parser and logging safety

- Use checked integer arithmetic for every chunk/box length, include padding in bounds checks, cap structural entries at 4,096, and stop as soon as the relevant declaration is known.
- Let Sharp validate checksums and compressed pixel data. PNG specifically recommends checking CRCs and treating malformed critical fields as errors in its [decoder security guidance](https://www.w3.org/TR/png-3/#13security-considerations).
- Never log bytes, base64, ICC/EXIF/XMP content, temporary paths, or a full file object. Filenames can contain personal data and should be omitted by default.
- Debug logs may contain collection slug, document id after one exists, normalized MIME, byte count, decoded format/dimensions/pages, stage, elapsed time, Sharp/libvips versions, and a sanitized error name/code/message. Stack traces belong only in debug mode.
- Keep Sharp and all native codec dependencies patched. `npm audit` alone cannot establish that every bundled decoder is safe; review Sharp/libvips release notes when updating.

## Determinism and data lifecycle

The same normalized RGBA bytes, dimensions, and component counts produce the same string in Wolt's pure-JavaScript encoder. The full native pipeline is deterministic enough for application idempotency when the exact Sharp/libvips/codecs, platform, options, and input bytes are fixed. It is **not a cross-version cryptographic identity**: decoder, colour-management, resampling, SIMD, and floating-point changes can move a coefficient across a quantization boundary.

Define the contract accordingly:

- generate only when an upload Buffer represents a new or replaced file;
- do not regenerate on metadata-only document updates;
- if the file is replaced, clear the prior value before attempting generation;
- on success store the new string; on skip or failure store `null` explicitly;
- never preserve the old hash after a replacement failure, because it would describe the wrong media;
- do not use the hash for deduplication, integrity, caching identity, or authorization;
- fixture tests should cover exact hashes on supported CI targets, while a dependency upgrade should also compare decoded previews visually or by a documented pixel tolerance.

Changing components, alpha background, normalization behavior, or decoder versions affects only future replacements in v1. Backfill/version migration remains a separate feature.

## Failure taxonomy and logging

The generator should return a discriminated result rather than throw expected upload conditions across the hook boundary. Configuration errors still throw during Payload startup.

| Code                  | Meaning                                                               | Stored value | Default log                                 |
| --------------------- | --------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| `not_eligible`        | A replacement has an unsupported declared MIME                        | `null`       | Debug only                                  |
| `type_mismatch`       | MIME, signature/container, or Sharp decoded type disagrees            | `null`       | Warning                                     |
| `animated_input`      | APNG, animated WebP, AVIF sequence, or multiple top-level pages       | `null`       | Debug only                                  |
| `malformed_container` | Bounded PNG/RIFF/ISOBMFF structure check fails                        | `null`       | Warning                                     |
| `input_too_large`     | Compressed-byte, pixel, side, page, or channel limit exceeded         | `null`       | Warning                                     |
| `decoder_unavailable` | This Sharp build lacks an expected decoder                            | `null`       | Warning once per process/format, then debug |
| `decode_timeout`      | Sharp crosses the 10-second processing limit                          | `null`       | Warning                                     |
| `decode_failed`       | Corrupt/truncated input, invalid profile, or native transform failure | `null`       | Warning                                     |
| `encode_failed`       | Raw shape assertion or BlurHash encoder fails                         | `null`       | Warning                                     |

Unsupported media and intentional animation skips are normal behavior and should not flood production logs. Every warning should include a stable code, collection, stage, and duration, allowing operators to aggregate it without parsing free-form messages. Debug mode adds bounded diagnostic context.

A metadata-only update has no generation result at all: the hook leaves the existing field unchanged because it invokes this module only when replacement bytes are present.

All per-upload outcomes above are recoverable: the media create/update continues. An invalid plugin option, impossible component pair, invalid background, non-positive resource limit, or missing `sharp`/`blurhash` module is a configuration error and should fail fast at startup.

At startup, inspect [`sharp.format`](https://sharp.pixelplumbing.com/api-utility/#format). If a promised decoder is unavailable, emit one warning naming the unavailable format. **Project choice (inference):** keep the app operational and skip only that format rather than failing the whole Payload configuration; custom system libvips builds legitimately vary. The integration app and published-package CI must use a build where all four decoders are present.

## Preview decoding

Use `blurhash`'s browser decoder directly; do not store a PNG preview, call a server endpoint, or add a second BlurHash implementation.

1. Validate the stored string with `isBlurhashValid` before decoding.
2. Derive a canvas size whose longest side is 32 pixels from the media width/height already on the document; fall back to 32 × 32 when dimensions are absent.
3. Bound both dimensions to 1–64, call `decode(hash, width, height, 1)`, construct `ImageData`, and paint once to canvas.
4. Scale the canvas to the admin field's display box with normal browser interpolation.
5. Memoize by `(hash, width, height)` and repaint only when those inputs change. There must be no animation or continuous render loop.
6. Catch validation/decode errors and show an inert “Preview unavailable” state; preview failure must never make the edit form unusable.

The official decoder returns opaque RGBA and documents the same [canvas flow](https://github.com/woltapp/blurhash/blob/712a47f946b98c30097eb1ada086ea00b18681ec/TypeScript/README.md#decodeblurhash-string-width-number-height-number-punch-number--uint8clampedarray). Use punch 1, the documented normal contrast. The browser component must import no server-only module, especially Sharp, so the native decoder cannot enter the admin bundle.

## What this adds to the plugin specification

The original options (`enabled`, `debug`, and selected collections) are insufficient to make supported transparent images and untrusted resource use predictable. Add three small, global advanced options:

```ts
type BlurHashPluginOptions = {
  enabled?: boolean;
  debug?: boolean;
  collections: string[];
  alphaBackground?: { r: number; g: number; b: number };
  components?: { x: number; y: number };
  limits?: {
    concurrency?: number;
    maxInputBytes?: number;
    maxInputPixels?: number;
    maxInputSide?: number;
    timeoutSeconds?: number;
  };
};
```

Defaults are those in the decision table. Keep the whole pipeline behind one generation function and one result type; do not expose decoder stages, container parsers, or Sharp controls as public plugin methods.

No separate logger package is warranted. This module should emit structured events through Payload's logger, with debug gating around diagnostic detail. A second plugin can later prove whether a shared logging adapter has a real stable interface.

## Verification requirements for implementation

The implementation handoff should include fixed binary fixtures and assertions for:

- valid baseline/progressive JPEG, grayscale and CMYK JPEG, PNG with/without alpha, static lossy/lossless WebP, and 8/10-bit AVIF;
- wrong MIME, wrong extension, truncated input, oversized bytes, oversized dimensions, and decoder timeout;
- APNG whose declared MIME is `image/png`, single-frame APNG with `acTL`, animated WebP, AVIF with `avis`, and an AVIF image collection;
- EXIF orientations 2–8, embedded ICC input, grayscale, alpha flattened on the configured colour, and transparent pixels with non-zero hidden RGB;
- exact 4 × 3 hash length and official decoder validity;
- identical repeated input on each supported CI platform;
- replace success followed by unsupported/failing replacement, proving the previous hash is cleared;
- concurrency never exceeding the configured plugin-local limit;
- logs containing no byte buffer, encoded image, metadata blob, path, or filename;
- a client-only static canvas preview that fails safely on an invalid value.

Collect decode, queue, total generation duration, skip/failure code, input bytes, and dimensions in the integration app under debug logging. Those measurements decide whether the inferred 25 MiB / 40 MP / 10-second / concurrency-2 defaults need adjustment before npm publication.
