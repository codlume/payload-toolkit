import React from "react";
import {
  createBlockRenderer,
  PreviewBridge,
  type BlockProps,
} from "@codlume/payload-live-preview/react";

type Text = { id?: string | null; blockType: "text"; content: string };
type Heading = { id?: string | null; blockType: "heading"; title: string };
type Parent = { content: number; theme: string };

const TextBlock = ({ block, marker, draft, parentProps }: BlockProps<Text, Parent>) => (
  <p {...marker} className={parentProps.theme}>
    {draft ? block.content : parentProps.content.toFixed()}
  </p>
);

const Blocks = createBlockRenderer<Text | Heading, Parent>({
  text: TextBlock,
  heading: ({ block, marker, parentProps }) => {
    const title: string = block.title;
    const content: number = parentProps.content;
    // @ts-expect-error the block is narrowed to Heading
    void block.content;
    return (
      <h2 {...marker}>
        {title}
        {content}
      </h2>
    );
  },
});

<Blocks
  blocks={[{ id: "row-1", blockType: "text", content: "Text" }]}
  draft
  parentProps={{ content: 7, theme: "dark" }}
/>;
<Blocks blocks={null} parentProps={{ content: 7, theme: "dark" }} />;
<Blocks blocks={undefined} parentProps={{ content: 7, theme: "dark" }} />;
<PreviewBridge serverURL="https://cms.example.com" debug />;

// @ts-expect-error every block type requires a component
createBlockRenderer<Text | Heading>({ text: () => null });
// @ts-expect-error parent props are required when declared
<Blocks blocks={[]} />;
// @ts-expect-error parent props preserve their field types
<Blocks blocks={[]} parentProps={{ content: "wrong", theme: "dark" }} />;
// @ts-expect-error bridge requires the expected Admin origin
<PreviewBridge />;

const Plain = createBlockRenderer<Text>({ text: ({ block }) => <p>{block.content}</p> });
<Plain blocks={[]} />;
// @ts-expect-error the empty parent-props contract omits parentProps
<Plain blocks={[]} parentProps={{}} />;
// @ts-expect-error the declared union rejects unknown block types
<Plain blocks={[{ blockType: "unknown" }]} />;
