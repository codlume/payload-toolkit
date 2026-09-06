# Payload Toolkit

Payload Toolkit is a monorepo for Codlume's open-source
[Payload CMS](https://payloadcms.com/) plugins. Each plugin is released
independently on npm. A private Payload app in `apps/payload-cms` supports
development and testing.

## Plugins

- [`@codlume/payload-activity`](https://www.npmjs.com/package/@codlume/payload-activity)
  records the admin user who last modified a document.
  [Documentation](packages/payload-activity/)
- [`@codlume/payload-blurhash`](https://www.npmjs.com/package/@codlume/payload-blurhash)
  generates and previews BlurHash placeholders for uploaded images.
  [Documentation](packages/payload-blurhash/)
- [`@codlume/payload-live-preview`](https://www.npmjs.com/package/@codlume/payload-live-preview)
  links blocks in Payload Admin with their rendered components in native Live
  Preview. Click a preview component to reveal its Admin row, or focus an Admin
  field to reveal its component.
  [Documentation](packages/payload-live-preview/)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup, test commands, and pull
request requirements.
