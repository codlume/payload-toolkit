import type { Plugin } from "payload";

export type LivePreviewPluginOptions = { enabled?: boolean; debug?: boolean };

export const livePreviewPlugin =
  ({ enabled = true, debug = false }: LivePreviewPluginOptions = {}): Plugin =>
  (config) => {
    if (!enabled || !config.collections) return config;
    return {
      ...config,
      collections: config.collections?.map((collection) => {
        if (!collection.admin?.livePreview) return collection;
        const admin = collection.admin;
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
                  {
                    path: "@codlume/payload-live-preview/client#PreviewBridgeAdmin",
                    clientProps: { debug },
                  },
                ],
              },
            },
          },
        };
      }),
    };
  };
