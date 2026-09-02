// PROTOTYPE — throwaway stand-in for the helper API decided in #83:
// `blockMarker(block, { draft })` and a `createBlockRenderer`-shaped renderer.

import type { ComponentType, ReactNode } from "react";

import { BLOCK_TYPE_ATTRIBUTE } from "./protocol.ts";

type AnyBlock = { blockType: string; id?: string | null };

export const blockMarker = (block: { id?: string | null }, { draft }: { draft: boolean }) =>
  draft && block.id ? { "data-payload-block": block.id } : {};

type BlockProps<TBlock> = {
  block: TBlock;
  draft: boolean;
  marker: Record<string, string>;
};

type Components<TBlock extends AnyBlock> = {
  [K in TBlock["blockType"]]: ComponentType<BlockProps<Extract<TBlock, { blockType: K }>>>;
};

export const createBlockRenderer = <TBlock extends AnyBlock>(components: Components<TBlock>) => {
  const RenderBlocks = ({
    blocks,
    draft = false,
  }: {
    blocks: TBlock[] | null | undefined;
    draft?: boolean;
  }) => (
    <>
      {(blocks ?? []).map((block) => {
        const Component = components[block.blockType as TBlock["blockType"]] as
          | ComponentType<BlockProps<TBlock>>
          | undefined;
        if (!Component) return null;
        // Prototype-only: variant B labels the hovered block with its type. The real marker carries the id only.
        const marker = {
          ...blockMarker(block, { draft }),
          ...(draft ? { [BLOCK_TYPE_ATTRIBUTE]: block.blockType } : {}),
        };
        return (
          <Component
            key={block.id ?? block.blockType}
            block={block}
            draft={draft}
            marker={marker}
          />
        );
      })}
    </>
  );
  return RenderBlocks;
};

// Fixture block components, shaped like the generated Page["layout"] union.

export type HeroBlock = {
  blockType: "hero";
  heading?: string | null;
  id?: string | null;
  text?: string | null;
};
export type TextBlock = { blockType: "text"; body?: string | null; id?: string | null };
export type QuoteBlock = {
  author?: string | null;
  blockType: "quote";
  id?: string | null;
  quote?: string | null;
};
export type ColumnBlock = {
  blockType: "column";
  content?: ContentBlock[] | null;
  id?: string | null;
};
export type ColumnsBlock = {
  blockType: "columns";
  columns?: ColumnBlock[] | null;
  id?: string | null;
};
export type ContentBlock = HeroBlock | TextBlock | QuoteBlock;
export type LayoutBlock = HeroBlock | TextBlock | QuoteBlock | ColumnsBlock;

const paragraphs = (body: string | null | undefined): ReactNode =>
  (body ?? "").split(/\n{2,}/).map((paragraph, i) => <p key={i}>{paragraph}</p>);

const Hero = ({ block, marker }: BlockProps<HeroBlock>) => (
  <header className="block block--hero" {...marker}>
    <h1>{block.heading}</h1>
    {block.text ? <p>{block.text}</p> : null}
  </header>
);

const Text = ({ block, marker }: BlockProps<TextBlock>) => (
  <section className="block block--text" {...marker}>
    {paragraphs(block.body)}
  </section>
);

const Quote = ({ block, marker }: BlockProps<QuoteBlock>) => (
  <blockquote className="block block--quote" {...marker}>
    <p>{block.quote}</p>
    {block.author ? <footer>{block.author}</footer> : null}
  </blockquote>
);

const RenderContent = createBlockRenderer<ContentBlock>({ hero: Hero, quote: Quote, text: Text });

const Column = ({ block, draft, marker }: BlockProps<ColumnBlock>) => (
  <div className="block block--column" {...marker}>
    <RenderContent blocks={block.content} draft={draft} />
  </div>
);

const RenderColumns = createBlockRenderer<ColumnBlock>({ column: Column });

const Columns = ({ block, draft, marker }: BlockProps<ColumnsBlock>) => (
  <section className="block block--columns" {...marker}>
    <RenderColumns blocks={block.columns} draft={draft} />
  </section>
);

export const RenderLayout = createBlockRenderer<LayoutBlock>({
  columns: Columns,
  hero: Hero,
  quote: Quote,
  text: Text,
});
