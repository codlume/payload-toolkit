import React from "react";
import { createBlockRenderer } from "@codlume/payload-live-preview/react";
import type { TextBlock } from "../payload-types.generated.ts";

export const PageBlocks = createBlockRenderer<TextBlock>({
  text: ({ block, marker }) => (
    <section {...marker} style={{ minHeight: "65vh", padding: "32px", whiteSpace: "pre-wrap" }}>
      {block.content}
    </section>
  ),
});
