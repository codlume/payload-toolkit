// PROTOTYPE — throwaway. Three variants of the linking feel, switchable via `?variant=`
// on the preview route. Each disagrees about hover structure, highlight rendering and
// the admin's scroll-and-expand ordering, all inside the constraints locked by #84.

import {
  BLOCK_TYPE_ATTRIBUTE,
  HIGHLIGHT_ATTRIBUTE,
  HOVER_ATTRIBUTE,
  VARIANT_ATTRIBUTE,
  type VariantKey,
} from "./protocol.ts";

export type Variant = {
  key: VariantKey;
  name: string;
  summary: string;
  /** Pure `:hover` CSS on every marked ancestor, or one delegated pointerover moving one attribute. */
  hover: "css" | "delegated";
  /** How long the highlight attribute stays on the element. */
  highlightMs: number;
  /** Admin: order of expanding collapsed ancestors and scrolling. */
  adminLocate: "expand-then-scroll" | "cascade" | "scroll-then-expand";
  /** Both sides: start the highlight as soon as the target is found, or once scrolling has ended. */
  highlightAfter: "appear" | "scrollend";
  scrollBehavior: ScrollBehavior;
};

export const VARIANTS: Record<VariantKey, Variant> = {
  A: {
    key: "A",
    name: "Quiet outline",
    summary:
      "CSS :hover outlines every marked ancestor. Highlight fades the outline. Admin expands everything at once, then scrolls smoothly while the highlight already runs.",
    hover: "css",
    highlightMs: 900,
    adminLocate: "expand-then-scroll",
    highlightAfter: "appear",
    scrollBehavior: "smooth",
  },
  B: {
    key: "B",
    name: "Innermost with label",
    summary:
      "One delegated pointerover marks only the innermost block, dashed, with a block-type label. Highlight is a tinted overlay fading out. Admin expands one level at a time and highlights after the scroll settles.",
    hover: "delegated",
    highlightMs: 1200,
    adminLocate: "cascade",
    highlightAfter: "scrollend",
    scrollBehavior: "smooth",
  },
  C: {
    key: "C",
    name: "Frame and pulse",
    summary:
      "CSS :hover frames the outermost section solid and hints inner blocks dashed. Highlight pulses the outline twice. Admin jumps to the nearest rendered ancestor first, expands, then jumps to the target.",
    hover: "css",
    highlightMs: 1000,
    adminLocate: "scroll-then-expand",
    highlightAfter: "appear",
    scrollBehavior: "instant",
  },
};

const BLUE = "37 99 235";
const GREEN = "16 185 129";
const scope = (key: VariantKey) => `html[${VARIANT_ATTRIBUTE}="${key}"]`;

/** Injected into the previewed page once the handshake completes. */
export const PREVIEW_CSS = `
${scope("A")} [data-payload-block] { cursor: default; }
${scope("A")} [data-payload-block]:hover { outline: 2px solid rgb(${BLUE}); outline-offset: -2px; }
${scope("A")} [data-payload-block][${HIGHLIGHT_ATTRIBUTE}] { outline: 3px solid rgb(${BLUE}); outline-offset: -3px; animation: lp-a-flash 900ms ease-out both; }
@keyframes lp-a-flash { from { outline-color: rgb(${BLUE}); } to { outline-color: rgb(${BLUE} / 0); } }

${scope("B")} [data-payload-block] { cursor: pointer; }
${scope("B")} [${HOVER_ATTRIBUTE}] { position: relative; outline: 2px dashed rgb(${BLUE}); outline-offset: 2px; }
${scope("B")} [${HOVER_ATTRIBUTE}]::before { content: attr(${BLOCK_TYPE_ATTRIBUTE}); position: absolute; top: 0; left: 0; z-index: 1; padding: 2px 8px; font: 600 11px/1.4 system-ui, sans-serif; letter-spacing: 0.02em; text-transform: uppercase; color: white; background: rgb(${BLUE}); border-radius: 0 0 6px 0; pointer-events: none; }
${scope("B")} [data-payload-block][${HIGHLIGHT_ATTRIBUTE}] { position: relative; }
${scope("B")} [data-payload-block][${HIGHLIGHT_ATTRIBUTE}]::after { content: ""; position: absolute; inset: 0; background: rgb(${BLUE}); pointer-events: none; animation: lp-b-fade 1200ms ease-out both; }
@keyframes lp-b-fade { from { opacity: 0.35; } to { opacity: 0; } }

${scope("C")} [data-payload-block] { cursor: pointer; }
${scope("C")} [data-payload-block]:hover { outline: 2px solid rgb(${GREEN}); outline-offset: 2px; }
${scope("C")} [data-payload-block]:hover [data-payload-block]:hover { outline: 1px dashed rgb(${GREEN} / 0.7); outline-offset: 0; }
${scope("C")} [data-payload-block][${HIGHLIGHT_ATTRIBUTE}] { outline: 3px solid rgb(${GREEN}); outline-offset: 2px; animation: lp-c-pulse 1000ms ease-in-out both; }
@keyframes lp-c-pulse { 0% { outline-color: rgb(${GREEN}); } 40% { outline-color: rgb(${GREEN} / 0); } 60% { outline-color: rgb(${GREEN}); } 100% { outline-color: rgb(${GREEN} / 0); } }
`;

/** Injected into Payload Admin while Live Preview is open. Targets the row's collapsible. */
export const ADMIN_CSS = `
${scope("A")} .blocks-field__row[${HIGHLIGHT_ATTRIBUTE}] { outline: 3px solid rgb(${BLUE}); outline-offset: 2px; animation: lp-a-flash 900ms ease-out both; }

${scope("B")} .blocks-field__row[${HIGHLIGHT_ATTRIBUTE}] { position: relative; }
${scope("B")} .blocks-field__row[${HIGHLIGHT_ATTRIBUTE}]::after { content: ""; position: absolute; inset: 0; z-index: 1; background: rgb(${BLUE}); border-radius: inherit; pointer-events: none; animation: lp-b-fade 1200ms ease-out both; }

${scope("C")} .blocks-field__row[${HIGHLIGHT_ATTRIBUTE}] { outline: 3px solid rgb(${GREEN}); outline-offset: 2px; animation: lp-c-pulse 1000ms ease-in-out both; }

@keyframes lp-a-flash { from { outline-color: rgb(${BLUE}); } to { outline-color: rgb(${BLUE} / 0); } }
@keyframes lp-b-fade { from { opacity: 0.35; } to { opacity: 0; } }
@keyframes lp-c-pulse { 0% { outline-color: rgb(${GREEN}); } 40% { outline-color: rgb(${GREEN} / 0); } 60% { outline-color: rgb(${GREEN}); } 100% { outline-color: rgb(${GREEN} / 0); } }
`;
