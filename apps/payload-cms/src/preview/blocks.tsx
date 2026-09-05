import React from "react";
import { createBlockRenderer } from "@codlume/payload-live-preview/react";
import type { TextBlock, SectionBlock } from "../payload-types.generated.ts";

export const PageBlocks = createBlockRenderer<TextBlock | SectionBlock, { textClass: string }>({
  text: ({ block, marker, parentProps }) => (
    <section
      {...marker}
      className={parentProps.textClass}
      style={{ minHeight: "65vh", padding: "32px", whiteSpace: "pre-wrap" }}
    >
      {block.content}
    </section>
  ),
  section: ({ block, marker, draft, parentProps }) => (
    <section {...marker} style={{ padding: "32px" }}>
      <h2>{block.heading}</h2>
      <PageBlocks blocks={block.content} draft={draft} parentProps={parentProps} />
    </section>
  ),
});
