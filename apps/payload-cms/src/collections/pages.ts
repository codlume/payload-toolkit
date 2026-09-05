import type { Block, CollectionConfig } from "payload";

const Text: Block = {
  slug: "text",
  interfaceName: "TextBlock",
  fields: [{ name: "content", type: "textarea", required: true }],
};

const NestedSection: Block = {
  slug: "section",
  interfaceName: "NestedSectionBlock",
  fields: [
    { name: "heading", type: "text", required: true },
    { name: "content", type: "blocks", blocks: [Text] },
  ],
};

const Section: Block = {
  slug: "section",
  interfaceName: "SectionBlock",
  fields: [
    { name: "heading", type: "text", required: true },
    { name: "content", type: "blocks", blocks: [Text, NestedSection] },
  ],
};

export const Pages: CollectionConfig = {
  slug: "pages",
  access: {
    read: ({ req }) => (req.user ? true : { _status: { equals: "published" } }),
    create: ({ req }) => Boolean(req.user),
    update: ({ req }) => Boolean(req.user),
    delete: ({ req }) => Boolean(req.user),
  },
  admin: {
    useAsTitle: "title",
    livePreview: {
      url: ({ data, req }) => {
        if (!data.slug) return null;
        const origin =
          process.env.PAYLOAD_PUBLIC_SERVER_URL ?? req.origin ?? "http://localhost:3000";
        return `${origin}/preview?slug=${encodeURIComponent(String(data.slug))}`;
      },
      breakpoints: [
        { label: "Mobile", name: "mobile", width: 375, height: 667 },
        { label: "Tablet", name: "tablet", width: 768, height: 1024 },
        { label: "Desktop", name: "desktop", width: 1440, height: 900 },
      ],
    },
  },
  versions: { drafts: { autosave: { interval: 800 } } },
  fields: [
    { name: "title", type: "text", required: true },
    { name: "slug", type: "text", required: true, unique: true },
    {
      name: "layout",
      type: "blocks",
      blocks: [Text, Section],
    },
  ],
};
