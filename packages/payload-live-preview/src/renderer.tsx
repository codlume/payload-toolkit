import { createElement, type ComponentType } from "react";
import { blockMarker, type Block } from "./marker.ts";

export type BlockProps<B extends Block, ParentProps = Record<never, never>> = {
  block: B;
  marker: ReturnType<typeof blockMarker>;
  draft: boolean;
  parentProps: ParentProps;
};

type RendererProps<B, P> = {
  blocks: B[] | null | undefined;
  draft?: boolean;
} & (keyof P extends never ? { parentProps?: never } : { parentProps: P });

/** Register once at module scope. Each component owns its root and marker placement. */
export const createBlockRenderer = <B extends Block, P = Record<never, never>>(components: {
  [Type in B["blockType"]]: ComponentType<BlockProps<Extract<B, { blockType: Type }>, P>>;
}) => {
  return function BlockRenderer(props: RendererProps<B, P>) {
    const draft = props.draft ?? false;
    return (
      props.blocks?.map((block, index) => {
        // The registry and block share a discriminant; TypeScript loses that relation on lookup.
        const Component = Object.hasOwn(components, block.blockType)
          ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- registry lookup preserves the block discriminant
            (components[block.blockType as B["blockType"]] as ComponentType<BlockProps<B, P>>)
          : undefined;
        return Component
          ? createElement(Component, {
              key: block.id ?? index,
              block,
              marker: blockMarker(block, { draft }),
              draft,
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only the empty-parent-props signature allows omission
              parentProps: (props.parentProps ?? {}) as P,
            })
          : null;
      }) ?? null
    );
  };
};
