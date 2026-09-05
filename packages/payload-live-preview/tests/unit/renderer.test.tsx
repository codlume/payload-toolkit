import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { createBlockRenderer, type BlockProps } from "../../src/react.ts";

type Text = { id?: string | null; blockType: "text"; content: string };
type Heading = { id?: string | null; blockType: "heading"; title: string };
const TextBlock = ({ block, marker, parentProps }: BlockProps<Text, { prefix: string }>) => (
  <p {...marker}>
    {parentProps.prefix}
    {block.content}
  </p>
);
const Render = createBlockRenderer<Text | Heading, { prefix: string }>({
  text: TextBlock,
  heading: ({ block, marker }) => <h2 {...marker}>{block.title}</h2>,
});

test("the server factory narrows components and marks their own elements", () => {
  expect(
    renderToStaticMarkup(
      <Render
        blocks={[{ id: "one", blockType: "text", content: "hello" }]}
        draft
        parentProps={{ prefix: "Say " }}
      />,
    ),
  ).toBe('<p data-payload-block="one" data-payload-block-type="text">Say hello</p>');
});

test("published rendering defaults to no markers and unknown types render nothing", () => {
  const Plain = createBlockRenderer<Text>({
    text: ({ block, marker }) => <p {...marker}>{block.content}</p>,
  });
  expect(
    renderToStaticMarkup(
      <Plain
        blocks={[
          { id: "one", blockType: "text", content: "hello" },
          // @ts-expect-error runtime content may be newer than the component registry
          { id: "two", blockType: "unknown" },
        ]}
      />,
    ),
  ).toBe("<p>hello</p>");
});

// Type contracts are checked by the workspace typecheck without invoking components.
function contracts() {
  // @ts-expect-error all block types need a component
  createBlockRenderer<Text | Heading>({ text: () => null });
  // @ts-expect-error non-empty parent props are required
  <Render blocks={[]} />;
  // @ts-expect-error parent props keep their declared types
  <Render blocks={[]} parentProps={{ prefix: 1 }} />;
  const Plain = createBlockRenderer<Text>({
    text: ({ block }) => {
      // @ts-expect-error narrowed text blocks have no title
      return block.title;
    },
  });
  // @ts-expect-error empty parent props are omitted
  <Plain blocks={[]} parentProps={{}} />;
}
void contracts;
