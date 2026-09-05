# Payload Live Preview

Link blocks in Payload Admin with their rendered components in native Live Preview. Click a preview component to reveal its Admin row, or focus an Admin field to reveal its component. Linking preserves focus and native click behavior.

Collections and globals configured for native Live Preview support nested blocks and repeated renderings. Linking follows the active locale and recovers after saves, iframe reloads, closing and reopening preview, and bridge remounts.

## Run the server example

From the workspace root:

```sh
pnpm install
pnpm services:up
pnpm build:packages
pnpm --filter @codlume/payload-cms dev
```

Open `http://localhost:3000/admin`, create an Admin user, then create a Page with a title, unique slug, text blocks and sections. Publish it, change some content, and open Live Preview. The workspace uses drafts and autosave. The preview entry authenticates the Payload user, enables Next draft mode, and redirects to `/pages/[slug]`.

The server route reads the latest draft only when both draft mode and Payload authentication are present. Ordinary requests read published content without block markers. Native `RefreshRouteOnSave` refreshes the route after draft saves, autosaves, and publishing. Unsaved form data does not stream into this server route. A new block becomes available after save or autosave.

Example sources:

- [Pages collection and native breakpoints](../../apps/payload-cms/src/collections/pages.ts)
- [Authenticated preview entry](<../../apps/payload-cms/src/app/(frontend)/preview/route.ts>)
- [Server page](<../../apps/payload-cms/src/app/(frontend)/pages/[slug]/page.tsx>)
- [Block components](../../apps/payload-cms/src/preview/blocks.tsx)
- [Authenticated page reads](../../apps/payload-cms/src/preview/read-page.ts)
- [Native refresh component](../../apps/payload-cms/src/preview/refresh.tsx)

Set `PAYLOAD_PUBLIC_SERVER_URL` to the application's public origin when it differs from the incoming request origin.

## Use client preview

The alternative [`/pages-client/[slug]` route](<../../apps/payload-cms/src/app/(frontend)/pages-client/[slug]/page.tsx>) authenticates and fetches initial data on the server, then renders [`ClientPage`](../../apps/payload-cms/src/preview/client-page.tsx) in draft mode. It uses Payload's native `useLivePreview` hook and the same block components to show unsaved form changes, including new blocks. Ordinary requests still render published content without markers or a bridge.

Set `PAYLOAD_LIVE_PREVIEW_MODE=client` when starting the workspace application to open this route from native Live Preview. Omit it to use the server route. The authenticated entry accepts `/preview?slug=your-page&mode=client`; other mode values select the server route. Route selection belongs to this example application.

```tsx
import { useLivePreview } from "@payloadcms/live-preview-react";
import { PreviewBridge } from "@codlume/payload-live-preview/react";

// Inside an authenticated draft client component:
const { data } = useLivePreview<Page>({ initialData, serverURL, depth: 0 });

return (
  <>
    <PageBlocks blocks={data.layout} draft={true} parentProps={{ textClass: "page-text" }} />
    <PreviewBridge serverURL={serverURL} />
  </>
);
```

The client alternative needs `@payloadcms/live-preview-react` in the frontend in addition to the plugin's React peer. Payload owns document streaming in both modes. Linking uses row ids and never streams document content itself. In server preview, a new block can only be located once save or autosave renders it; an available ancestor can be located sooner, and missing targets expire after two seconds.

Both peers reconnect through the plugin's ready handshake. Admin cancels pending selections and clears selection deduplication when the preview URL or iframe changes, on iframe load, and on close/reopen. Disconnected locates are dropped without replay. Multiple frontend bridge registrations share one connection; dispose each registration on unmount. Final disposal removes interaction listeners, target waits, styles, temporary attributes, and positioning. A later mount starts a fresh handshake.

## Install in your application

Add the package to your existing Payload application:

```sh
pnpm add @codlume/payload-live-preview
```

The package has four public entries. Install the peers used by the entries you import.

| Import                                 | Exports                                                   | Required peers                                            |
| -------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------- |
| `@codlume/payload-live-preview`        | `livePreviewPlugin`, type `LivePreviewPluginOptions`      | `payload >=3.88.0 <4`                                     |
| `@codlume/payload-live-preview/core`   | `blockMarker`, `createPreviewBridge`                      | None                                                      |
| `@codlume/payload-live-preview/react`  | `PreviewBridge`, `createBlockRenderer`, type `BlockProps` | `react ^19.0.1 \|\| ^19.1.2 \|\| ^19.2.1`                 |
| `@codlume/payload-live-preview/client` | `PreviewBridgeAdmin`                                      | Payload, matching `@payloadcms/ui >=3.88.0 <4`, and React |

Payload's generated import map imports the Admin entry. The plugin registers it for you. Implementation modules under `dist/` and `src/` are private.

For a separate React frontend, install the package and React in that frontend:

```sh
pnpm add @codlume/payload-live-preview 'react@^19.2.1'
```

Import only `/react` and, if needed, `/core` there. These entries do not depend on Payload or Payload UI. Keep the root configuration import in the CMS application. Your framework supplies its own dependencies, such as Next and React DOM; the plugin does not declare them as peers.

A frontend using only `/core` needs just `@codlume/payload-live-preview`, with no React or Payload installation. All package peers are optional so each application can install only those it uses. Optional does not mean an imported integration works without its peers. Supported Node versions are `>=22.12.0 <23 || >=24.0.0 <25`; the packed Payload consumer checks the 3.88.0 compatibility baseline.

## Configure Payload

```ts
import { livePreviewPlugin } from "@codlume/payload-live-preview";

// Add to your existing Payload configuration:
plugins: [livePreviewPlugin()];
```

Configure `admin.livePreview` on each collection or global, or include its slug in the root `admin.livePreview.collections` or `admin.livePreview.globals` list. A root URL alone does not enable entities. The plugin uses Payload's own URL and breakpoint options and needs no separate slug lists.

The plugin appends `@codlume/payload-live-preview/client#PreviewBridgeAdmin` to collection `admin.components.edit.beforeDocumentControls` and global `admin.components.elements.beforeDocumentControls`. It preserves existing controls and preview components. Regenerate the Payload import map after adding the plugin.

Conditional URL functions run through Payload for the current document and locale. The plugin never evaluates them during configuration. Returning `null` or `undefined` leaves linking inactive until native Live Preview becomes available.

`enabled` defaults to `true`. With `enabled: false`, the plugin returns the original configuration unchanged. `debug` defaults to `false` and controls Admin diagnostics. The bridge renders no DOM and activates only in native iframe preview mode.

Linking follows Payload's active locale. Changing locale cancels pending locates on both sides through a renewed handshake and clears the previous block selection, even when the preview URL stays the same. Subsequent selections use current form fields. If the iframe navigates, the bridge reconnects. Preview URLs and frontend data reads must use the active locale, as with native Live Preview. There is no cross-locale id mapping or selection replay.

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

Forward both `draft` and `parentProps` when rendering nested content. The workspace example supports section → section → text with generated Payload types. In the outer section, enter a heading to show its nested content fields. Its schema uses finite nesting because the SQLite adapter in Payload 3.88 cannot build a self-referencing block schema.

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

`serverURL` is required for both bridge APIs and identifies the expected Payload Admin origin, such as `https://cms.example.com` when the frontend lives on a different origin. It does not select the preview route or stream document data. Continue using Payload's native preview integration for updates.

## Diagnostics and validation

Enable `debug` separately on the plugin and frontend bridge. Console lines use `[@codlume/payload-live-preview:admin]` or `[@codlume/payload-live-preview:preview]` and report connection/reset, sent/received locate ids, fallback, missing targets, timeouts, disconnected drops, and rejected plugin messages. They exclude document content, URL query strings, hover and typing. Debug-off failures are silent.

```sh
pnpm --filter @codlume/payload-live-preview test:unit
pnpm --filter @codlume/payload-live-preview test:build
pnpm --filter @codlume/payload-live-preview test:pack
pnpm --filter @codlume/payload-cms exec vitest run tests/integration/pages-preview.test.ts
pnpm --filter @codlume/payload-cms test:e2e
```

The packed-consumer suite installs a real tarball into temporary core-only, React, and Payload projects outside the workspace. It checks declarations, private imports, peer isolation, rendered Next server/client routes, and the generated Admin import map. The root `pnpm test:pack` runs this suite and the BlurHash packed-consumer suite; `pnpm ready` includes that gate.
