# Read-only sidebar field injection for Payload 3.88 (collections and globals)

Verified against the pinned `payload@3.88.0`, `@payloadcms/ui@3.88.0`, and
`@payloadcms/next@3.88.0` installed at `apps/payload-cms/node_modules`. Citations
give the package-relative dist path (with verified line numbers) and link to the
matching source file on GitHub at tag `v3.88.0`; GitHub line numbers are omitted
because they were not independently verified against the `.ts` sources.

## Recommendation

Inject one field object into both `config.collections[n].fields` and
`config.globals[n].fields`; the `Field` type is identical in both. Give it
`admin: { position: 'sidebar', readOnly: true, components: { Field: '<pkg>/client#<Export>' } }`.
Keep the plugin shape of `@codlume/payload-blurhash`: a pure `Plugin` function
that maps over the configured entities and spreads a new `fields` array, plus a
`./client` package export whose components carry `"use client"`. Type plugin
options as `CollectionSlug[]` and `GlobalSlug[]` from `payload`. Make the field
component a client component: read the raw relationship ID with `useField`, fetch
the related user doc over REST (form state is built at `depth: 0`, so the value
is never populated), and build the link with `formatAdminURL` from
`payload/shared` plus `useConfig().config.routes.admin`. Enforce read-only on the
server with field `access.update: () => false`; `admin.readOnly` is UI-only.

## Verified facts

### 1. Globals accept field injection exactly like collections

- `Config.globals?: GlobalConfig[]` sits next to `Config.collections`
  (`payload/dist/config/types.d.ts:1016`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/config/types.ts)).
- `GlobalConfig` has `fields: Field[]`, the same `Field` union collections use
  (`payload/dist/globals/config/types.d.ts:223`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/globals/config/types.ts)).
  So the BlurHash plugin's collection mapping
  (`packages/payload-blurhash/src/plugin.ts:471-482`, spread config + map
  `config.collections`) ports one-to-one: add a sibling map over
  `config.globals ?? []`.
- A `Plugin` is `(config: Config) => Config | Promise<Config>` with optional
  `slug`/`order`/`options` (`payload/dist/config/types.d.ts:61-68`).
- Differences that matter to a plugin: `GlobalConfig` has no `upload`, no
  `access.create/delete` (only `read`/`readVersions`/`update`,
  `payload/dist/globals/config/types.d.ts:210-214`), and field hooks running on a
  global receive `global: SanitizedGlobalConfig` (null for collections) in their
  args (`payload/dist/fields/config/types.d.ts:44-45`).

### 2. `admin.position: 'sidebar'`, sidebar grouping, `admin.readOnly`

- `FieldPosition = 'main' | 'sidebar'` and the shared `FieldAdmin` base carries
  `position?: FieldPosition` and `readOnly?: boolean`
  (`payload/dist/fields/config/types.d.ts:171,214-215`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/fields/config/types.ts)).
  Every field type's `admin` extends `FieldAdmin` (including layout fields such
  as `row`, `payload/dist/fields/config/types.d.ts:596-600`). Two exceptions:
  the `ui` field types position loosely as `position?: string`
  (`payload/dist/fields/config/types.d.ts:712`) and the `join` field forbids
  `readOnly` (`readOnly?: never`, `payload/dist/fields/config/types.d.ts:1335`).
- Grouping is a single predicate: `fieldIsSidebar` returns true when
  `field.admin.position === 'sidebar'` (`payload/dist/fields/config/types.js:34-36`).
- The edit view splits fields once, at the top level: `DocumentFields` reduces
  the root `fields` array into `mainFields`/`sidebarFields` via `fieldIsSidebar`
  and renders the sidebar column only when at least one exists
  (`@payloadcms/ui/dist/elements/DocumentFields/index.js:26-77`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/ui/src/elements/DocumentFields/index.tsx)).
  Inference: because only the root array is split, `position: 'sidebar'` on a
  field nested inside a group/tab has no sidebar effect; inject at the top level.
- Collections and globals share this rendering path: the default edit view
  resolves `collectionConfig` or `globalConfig` from the same component and
  feeds `DocumentFields` either way
  (`@payloadcms/ui/dist/views/Edit/index.js:123-126,577`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/ui/src/views/Edit/index.tsx)).
- `admin.readOnly` flows to the client field config and disables editing in the
  admin UI only. For enforcement, pair it with field-level
  `access: { create: () => false, update: () => false }`, exactly as the
  BlurHash plugin does (`packages/payload-blurhash/src/plugin.ts:412-436`).

### 3. Custom Field components, `PayloadComponent`, importMap

- `admin.components.Field?: PayloadComponent<FieldClientComponent | FieldServerComponent>`
  (`payload/dist/fields/config/types.d.ts:174-183`). `PayloadComponent` is
  `false | string | RawPayloadComponent` where the object form is
  `{ path, exportName?, clientProps?, serverProps? }`
  (`payload/dist/config/types.d.ts:32-38`). String form: `'package#export'`;
  without `#`, the export name defaults to `'default'`
  (`payload/dist/bin/generateImportMap/utilities/parsePayloadComponent.js`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/bin/generateImportMap/utilities/parsePayloadComponent.ts)).
- Server vs client: at render time `RenderServerComponent` resolves the string
  through the import map, then checks `isReactServerComponentOrFunction`. A
  plain function that is not a `react.client.reference` (i.e. not behind
  `"use client"`) counts as a server component and additionally receives
  `serverProps`; client components receive only `clientProps`
  (`@payloadcms/ui/dist/elements/RenderServerComponent/index.js:36-55`,
  `payload/dist/utilities/isReactComponent.js:1-4`).
- importMap: string component paths are resolved at runtime from
  `payload.importMap`; a missing entry logs
  "You may need to run the `payload generate:importmap` command"
  (`payload/dist/bin/generateImportMap/utilities/getFromImportMap.js`). The
  `generate:importmap` bin script exists (`payload/dist/bin/index.js:15,122`)
  and writes `importMap.js` into `app/(payload)/<adminRoute>/` or
  `src/app/(payload)/<adminRoute>/`
  (`payload/dist/bin/generateImportMap/utilities/resolveImportMapFilePath.js`).
  Generation iterates globals as well as collections
  (`payload/dist/bin/generateImportMap/iterateGlobals.d.ts`), so a field injected
  into a global gets its component picked up the same way.
- The BlurHash mapping to copy: `plugin.ts` sets
  `components: { Field: "@codlume/payload-blurhash/client#BlurHashPreview" }`
  (`packages/payload-blurhash/src/plugin.ts:421-423`); `src/client.ts` re-exports
  the component; `blur-hash-preview.tsx` starts with `"use client"` (making it a
  client component under the check above); and `package.json` maps the specifier
  via `exports["./client"]` to `dist/client.mjs`
  (`packages/payload-blurhash/package.json:33-42`). The `package#export` string
  is what consumers' import maps record.

### 4. What the field component gets for free vs. what it must fetch

- Client component props: `{ field, path, permissions, readOnly, schemaPath }`
  (assembled in `@payloadcms/ui/dist/forms/fieldSchemasToFormState/renderField.js:46-52`,
  custom `Field` rendered at lines 278-289, wrapped in `WatchCondition`;
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/ui/src/forms/fieldSchemasToFormState/renderField.tsx)).
  No document data is in the props — read it from hooks.
- Server component props additionally include `data` (full doc), `siblingData`,
  `value` (`data[field.name]`), `id`, `collectionSlug`, `payload`, `req`, `user`,
  `i18n`, `formState` (`payload/dist/admin/forms/Field.d.ts:65-97`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/admin/forms/Field.ts);
  `value` computed at `renderField.js:81`). A server component can therefore call
  `payload.findByID` directly.
- The value is an ID, not a populated doc: the edit view loads the document with
  `depth: 0` for both collections (`payload.findByID`) and globals
  (`payload.findGlobal`)
  (`@payloadcms/next/dist/views/Document/getDocumentData.js:22-51`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/next/src/views/Document/getDocumentData.ts)).
  Relationship form values are typed `RelationshipValueSingle = number | string | ValueWithRelation`
  (`payload/dist/fields/config/types.d.ts:971-978`). Resolving the user's title
  therefore requires a fetch, client- or server-side.
- Client hooks (all exported from `@payloadcms/ui`,
  `@payloadcms/ui/dist/exports/client/index.d.ts:9,193,239,241`):
  - `useField<T>({ path })` → `{ value, setValue, initialValue, ... }`
    (`@payloadcms/ui/dist/forms/useField/types.d.ts:28-42`).
  - `useDocumentInfo()` → `DocumentInfoContext` with `data` (the last-saved doc;
    read `data?.updatedAt` from it), `initialData`, `lastUpdateTime: number`,
    `id`, `collectionSlug`, `globalSlug`; `savedDocumentData` still exists but is
    deprecated in favor of `data`
    (`@payloadcms/ui/dist/providers/DocumentInfo/types.d.ts:27-33,43-62`).
  - `useConfig()` → `{ config: ClientConfig, getEntityConfig }`; `getEntityConfig`
    is the O(1) way to grab the users collection's client config
    (`@payloadcms/ui/dist/providers/Config/index.d.ts:17-31`).
  - `usePayloadAPI(url, { initialParams })` → `[{ data, isLoading, isError }, { setParams }]`
    (`@payloadcms/ui/dist/hooks/usePayloadAPI.d.ts`).
- `useAsTitle` with email fallback: `CollectionConfig.admin.useAsTitle?: string`
  (`payload/dist/collections/config/types.d.ts:443`). Sanitization already
  defaults auth collections to `useAsTitle: 'email'` (or `'username'` with
  `loginWithUsername`) (`payload/dist/collections/config/sanitize.js:235-237`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/collections/config/sanitize.ts)),
  so `usersConfig?.admin?.useAsTitle || 'email'` matches Payload's own behavior.
  Payload's Relationship input does the same dance: it selects
  `collection?.admin?.useAsTitle || 'id'` and fetches the related docs over REST
  (`@payloadcms/ui/dist/fields/Relationship/Input.js:353-380`).
- Admin document URL: Payload's own Relationship input builds it as
  `formatAdminURL({ adminRoute: config.routes.admin, path: '/collections/${slug}/${id}', serverURL })`
  (`@payloadcms/ui/dist/fields/Relationship/Input.js:530-535`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/ui/src/fields/Relationship/Input.tsx)).
  `formatAdminURL` handles `routes.admin === '/'` and Next `basePath`, and is a
  `payload/shared` export (`payload/dist/utilities/formatAdminURL.d.ts`,
  `payload/dist/exports/shared.d.ts:29`).

### 5. `CollectionSlug` and `GlobalSlug` typing

- Both are exported from `payload`:
  `CollectionSlug = StringKeyOf<PayloadTypes['collections']>` and
  `GlobalSlug = StringKeyOf<PayloadTypes['globals']>`
  (`payload/dist/index.d.ts:204,212`,
  [src](https://github.com/payloadcms/payload/blob/v3.88.0/packages/payload/src/index.ts)).
  `UploadCollectionSlug` (used by the BlurHash options) and `AuthCollectionSlug`
  live alongside them (`payload/dist/index.d.ts:210,224`).
- `GeneratedTypes` is an empty interface meant for module augmentation by the
  app's `payload-types.ts` (`payload/dist/index.d.ts:158-163`). `PayloadTypes`
  merges it with `UntypedPayloadTypes` when augmented; when no generated types
  exist, `collections` and `globals` fall back to `{ [slug: string]: ... }`, so
  both slug types degrade to plain `string` (`payload/dist/index.d.ts:96-190`).

## Code sketch

Plugin injection (mirrors `packages/payload-blurhash/src/plugin.ts`):

```ts
import type { CollectionSlug, Config, Field, GlobalSlug, Plugin } from "payload";

type Options = { collections?: CollectionSlug[]; globals?: GlobalSlug[] };

const createSidebarField = (): Field => ({
  name: "lastEditedBy",
  type: "relationship",
  relationTo: "users",
  access: { create: () => false, update: () => false }, // real enforcement
  admin: {
    position: "sidebar",
    readOnly: true, // UI affordance only
    components: { Field: "@codlume/payload-xyz/client#LastEditedByField" },
  },
});

export const xyzPlugin = (options: Options): Plugin => (config: Config) => ({
  ...config,
  collections: (config.collections ?? []).map((collection) =>
    options.collections?.includes(collection.slug)
      ? { ...collection, fields: [...collection.fields, createSidebarField()] }
      : collection,
  ),
  globals: (config.globals ?? []).map((global) =>
    options.globals?.includes(global.slug)
      ? { ...global, fields: [...global.fields, createSidebarField()] }
      : global,
  ),
});
```

Client field component (exported from the package's `./client` entry with
`"use client"`; `admin.components.Field` replaces the entire field UI, label
included, so render `FieldLabel` yourself as `BlurHashPreview` does):

```tsx
"use client";
import { useConfig, useDocumentInfo, useField, usePayloadAPI } from "@payloadcms/ui";
import type { RelationshipFieldClientComponent } from "payload";
import { formatAdminURL } from "payload/shared";

export const LastEditedByField: RelationshipFieldClientComponent = ({ path }) => {
  const { value } = useField<number | string>({ path }); // depth-0 → user ID
  const { data } = useDocumentInfo(); // last-saved doc → data?.updatedAt
  const { config, getEntityConfig } = useConfig();

  const usersConfig = getEntityConfig({ collectionSlug: "users" });
  const titleField = usersConfig?.admin?.useAsTitle || "email"; // sanitize.js already defaults auth collections to "email"

  const [{ data: user }] = usePayloadAPI(
    `${config.serverURL}${config.routes.api}/users/${value}`,
  ); // form state never holds the populated doc

  const href = formatAdminURL({
    adminRoute: config.routes.admin,
    path: `/collections/users/${value}`,
    serverURL: config.serverURL,
  });

  return value ? <a href={href}>{user?.[titleField] || user?.email || String(value)}</a> : null;
};
```

Server-component alternative: omit `"use client"`, type it as
`FieldServerComponent`, and use the free `data`, `value`, and `payload` props.
`await payload.findByID({ collection: "users", id: value, depth: 0 })` replaces
the client fetch, at the cost of no hook access.
