# Payload Live Preview

Link blocks in Payload Admin with their rendered components in native Live Preview. Click a preview component to reveal its Admin row, or focus an Admin field to reveal its component. Linking preserves focus and native click behavior.

Collections with per-collection Live Preview support nested blocks and repeated renderings. Update/restart coverage, globals, root configuration, locale handling, and isolated packed consumers are tracked in [#97–#99](https://github.com/codlume/payload-toolkit/issues/94).

## Run the server example

From the workspace root:

```sh
pnpm install
pnpm services:up
pnpm build:packages
pnpm --filter @codlume/payload-cms dev
```

Open `http://localhost:3000/admin`, create an Admin user, then create a Page with a title, unique slug, text blocks and sections. Publish it, change some content, and open Live Preview. The workspace uses drafts and autosave. The preview entry authenticates the Payload user, enables Next draft mode, and redirects to `/pages/[slug]`.

The server route reads the latest draft only when both draft mode and Payload authentication are present. Ordinary requests read published content without block markers. Native `RefreshRouteOnSave` refreshes the route after saves and autosaves. Unsaved form data does not stream into this server route. A new block becomes available after save or autosave.

Example sources:

- [Pages collection and native breakpoints](../../apps/payload-cms/src/collections/pages.ts)
- [Authenticated preview entry](<../../apps/payload-cms/src/app/(frontend)/preview/route.ts>)
- [Server page](<../../apps/payload-cms/src/app/(frontend)/pages/[slug]/page.tsx>)
- [Block components](../../apps/payload-cms/src/preview/blocks.tsx)
- [Authenticated page reads](../../apps/payload-cms/src/preview/read-page.ts)
- [Native refresh component](../../apps/payload-cms/src/preview/refresh.tsx)

Set `PAYLOAD_PUBLIC_SERVER_URL` to the application's public origin when it differs from the incoming request origin.

## Configure Payload

```ts
import { livePreviewPlugin } from "@codlume/payload-live-preview";

// Add to your existing Payload configuration:
plugins: [livePreviewPlugin()];
```

Configure `admin.livePreview` on the collection using Payload's own URL and breakpoint options. The plugin appends `@codlume/payload-live-preview/client#PreviewBridgeAdmin` to existing edit controls. Regenerate the Payload import map after adding the plugin.

`enabled` defaults to `true`. With `enabled: false`, the plugin returns the original configuration unchanged. `debug` defaults to `false` and controls Admin diagnostics. The bridge renders no DOM and activates only in native iframe preview mode.

## Render blocks

Create the renderer at module scope, including in a server module. Register a component for every member of your generated block union. Each component spreads its marker on its own real element.

```tsx
import { createBlockRenderer, PreviewBridge } from '@codlume/payload-live-preview/react'
import type { TextBlock, SectionBlock } from './payload-types'

const Blocks = createBlockRenderer<TextBlock | SectionBlock, { theme: string }>({
  text: ({ block, marker, parentProps }) => (
    <section {...marker} className={parentProps.theme}>{block.content}</section>
  ),
  section: ({ block, marker, draft, parentProps }) => (
    <section {...marker}>
      <h2>{block.heading}</h2>
      <Blocks blocks={block.content} draft={draft} parentProps={parentProps} />
    </section>
  ),
})

// Inside your authenticated server page:
<Blocks blocks={page.layout} draft={draft} parentProps={{ theme: 'page-text' }} />
{draft && <PreviewBridge serverURL="https://cms.example.com" />}
```

`draft` defaults to `false`. When declaring parent props, the renderer requires them; otherwise omit `parentProps`. Components receive `block`, `marker`, `draft`, and `parentProps` separately. The public `BlockProps` type describes that contract. Unknown runtime block types render nothing.

Forward both `draft` and `parentProps` when rendering nested content. The workspace example supports section → section → text with generated Payload types. Its schema uses finite nesting because the SQLite adapter in Payload 3.88 cannot build a self-referencing block schema.

A preview click selects the innermost marked block. Admin expands collapsed ancestors from the outside inward and saves their expanded state. If an inner block is unavailable, linking tries its enclosing blocks. Missing targets can appear within a two-second wait; a new selection cancels the previous wait.

Multiple elements can spread the same marker. Locating uses the first rendered, visible copy in DOM order, including off-screen copies. Hidden copies are skipped. Clicking any copy reveals the same Admin row.

`PreviewBridge` manages the bridge lifecycle and takes a required `serverURL` plus optional `debug`. It is a separate client component; the React entry and renderer factory remain callable from server modules. Pair it with Payload's native server-preview refresh integration as shown in the fixture.

## Use core without React

```ts
import { blockMarker, createPreviewBridge } from "@codlume/payload-live-preview/core";

const attributes = blockMarker(block, { draft: true });
const cleanup = createPreviewBridge({ serverURL: "https://cms.example.com" });
// Apply attributes to the component's root. Dispose when the integration unmounts.
cleanup();
```

The marker uses Payload's existing block-row `id`. It adds `data-payload-block` and the display-only `data-payload-block-type` only when draft is true and an id exists. The required second argument prevents accidental published markers. Core imports are inert without a browser. Standalone draft pages can have markers but never activate linking.

The configuration entry requires Payload `>=3.88.0 <4`. The Admin entry requires matching Payload UI `>=3.88.0 <4` and React. React consumers need `react ^19.0.1 || ^19.1.2 || ^19.2.1`; core consumers need none of these peers. Optional peer metadata lets each consumer install only the dependencies its entry requires. Supported Node versions are `>=22.12.0 <23 || >=24.0.0 <25`.

## Diagnostics and validation

Enable `debug` separately on the plugin and frontend bridge. Console lines use `[@codlume/payload-live-preview:admin]` or `[@codlume/payload-live-preview:preview]` and report connection/reset, sent/received locate ids, fallback, missing targets, timeouts, and rejected plugin messages. They exclude document content, URL query strings, hover and typing. Debug-off failures are silent.

```sh
pnpm --filter @codlume/payload-live-preview test:unit
pnpm --filter @codlume/payload-live-preview test:build
pnpm --filter @codlume/payload-cms exec vitest run tests/integration/pages-preview.test.ts
pnpm --filter @codlume/payload-cms test:e2e
```
