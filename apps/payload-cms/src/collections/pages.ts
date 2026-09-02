import type { Block, CollectionConfig } from "payload";

// Fixture collection for the Live Preview plugin: blocks nested three levels deep
// (layout → columns → column.content) so locate has collapsed ancestors to expand.

const hero: Block = {
  slug: "hero",
  fields: [
    { name: "heading", type: "text", required: true },
    { name: "text", type: "textarea" },
  ],
};

const text: Block = {
  slug: "text",
  fields: [{ name: "body", type: "textarea", required: true }],
};

const quote: Block = {
  slug: "quote",
  fields: [
    { name: "quote", type: "textarea", required: true },
    { name: "author", type: "text" },
  ],
};

const column: Block = {
  slug: "column",
  fields: [
    {
      name: "content",
      type: "blocks",
      admin: { initCollapsed: true },
      blocks: [hero, text, quote],
    },
  ],
};

const columns: Block = {
  slug: "columns",
  fields: [
    {
      name: "columns",
      type: "blocks",
      admin: { initCollapsed: true },
      blocks: [column],
    },
  ],
};

export const createPagesCollection = (serverURL: string): CollectionConfig => ({
  slug: "pages",
  access: { read: () => true },
  admin: {
    useAsTitle: "title",
    livePreview: {
      url: ({ data }) => (data.id ? `${serverURL}/prototype/pages/${data.id}` : null),
    },
    components: {
      edit: {
        // PROTOTYPE — throwaway admin side of the linking bridge (#85).
        beforeDocumentControls: [
          {
            path: "/src/prototype-live-preview-linking/admin-bridge#LinkingBridge",
            clientProps: { debug: true },
          },
        ],
      },
    },
  },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, unique: true },
    {
      name: "layout",
      type: "blocks",
      blocks: [hero, text, quote, columns],
    },
  ],
  versions: { drafts: true },
});
