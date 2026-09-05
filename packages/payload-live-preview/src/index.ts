import type { Plugin } from "payload";

export type LivePreviewPluginOptions = { enabled?: boolean; debug?: boolean };

export const livePreviewPlugin =
  ({ enabled = true, debug = false }: LivePreviewPluginOptions = {}): Plugin =>
  (config) => {
    if (!enabled) return config;
    const bridge = {
      path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
      clientProps: { debug },
    };
    const result = { ...config };
    if (config.collections)
      result.collections = config.collections.map((collection) => {
        if (
          !collection.admin?.livePreview &&
          !config.admin?.livePreview?.collections?.includes(collection.slug)
        )
          return collection;
        const admin = collection.admin ?? {};
        return {
          ...collection,
          admin: {
            ...admin,
            components: {
              ...admin.components,
              edit: {
                ...admin.components?.edit,
                beforeDocumentControls: [
                  ...(admin.components?.edit?.beforeDocumentControls ?? []),
                  bridge,
                ],
              },
            },
          },
        };
      });
    if (config.globals)
      result.globals = config.globals.map((global) => {
        if (
          !global.admin?.livePreview &&
          !config.admin?.livePreview?.globals?.includes(global.slug)
        )
          return global;
        const admin = global.admin ?? {};
        return {
          ...global,
          admin: {
            ...admin,
            components: {
              ...admin.components,
              elements: {
                ...admin.components?.elements,
                beforeDocumentControls: [
                  ...(admin.components?.elements?.beforeDocumentControls ?? []),
                  bridge,
                ],
              },
            },
          },
        };
      });
    return result;
  };
