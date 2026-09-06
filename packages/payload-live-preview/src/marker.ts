export type Block = { id?: string | null; blockType: string };

/** Spread on the component's own element; published renders carry no markers. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- accept generated block object literals with extra fields
export const blockMarker = <T extends Block>(block: T, { draft }: { draft: boolean }) =>
  draft && block.id
    ? { "data-payload-block": block.id, "data-payload-block-type": block.blockType }
    : {};
