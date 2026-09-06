import React from "react";
import { createBlockRenderer, type BlockProps } from "@codlume/payload-live-preview/react";

type Text = { id: string; blockType: "text"; content: string };
type Section = { id: string; blockType: "section"; content: Block[] };
type Block = Text | Section;
type Parent = { content: string };

function SectionBlock({ block, marker, draft, parentProps }: BlockProps<Section, Parent>) {
  return (
    <section {...marker}>
      <Blocks blocks={block.content} draft={draft} parentProps={parentProps} />
    </section>
  );
}

// This factory runs in the server graph and, through the client route, the client graph.
export const Blocks = createBlockRenderer<Block, Parent>({
  text: ({ block, marker, parentProps }) => (
    <p {...marker}>
      {parentProps.content}
      {block.content}
    </p>
  ),
  section: SectionBlock,
});

export const blocks: Block[] = [
  {
    id: "section-1",
    blockType: "section",
    content: [{ id: "text-1", blockType: "text", content: "Nested text" }],
  },
];
