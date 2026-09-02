// PROTOTYPE — throwaway. Wire format from the protocol decision (#84) plus one
// prototype-only `variant` event so the preview's switcher drives the admin side too.

export const MESSAGE_TYPE = "@codlume/payload-live-preview";

export const VARIANT_KEYS = ["A", "B", "C"] as const;
export type VariantKey = (typeof VARIANT_KEYS)[number];

export type BridgeMessage =
  | { event: "ready"; type: typeof MESSAGE_TYPE }
  | { event: "locate"; ids: string[]; type: typeof MESSAGE_TYPE }
  | { event: "variant"; type: typeof MESSAGE_TYPE; variant: VariantKey };

export const isVariantKey = (value: unknown): value is VariantKey =>
  typeof value === "string" && (VARIANT_KEYS as readonly string[]).includes(value);

export const isBridgeMessage = (data: unknown): data is BridgeMessage => {
  if (typeof data !== "object" || data === null) return false;
  const record = data as Record<string, unknown>;
  if (record.type !== MESSAGE_TYPE) return false;
  if (record.event === "ready") return true;
  if (record.event === "locate") return Array.isArray(record.ids);
  if (record.event === "variant") return isVariantKey(record.variant);
  return false;
};

/** Set on `document.documentElement` on both sides; every injected rule is scoped under it. */
export const VARIANT_ATTRIBUTE = "data-lp-proto-variant";
/** One-shot highlight: set on the located element, removed by a single setTimeout. */
export const HIGHLIGHT_ATTRIBUTE = "data-lp-highlight";
/** Variant B only: moved by one delegated pointerover listener to the innermost marked element. */
export const HOVER_ATTRIBUTE = "data-lp-hover";
/** Prototype-only: block type on the marked element so variant B can label it. Not part of blockMarker (#83). */
export const BLOCK_TYPE_ATTRIBUTE = "data-lp-proto-type";

export const LOCATE_TIMEOUT_MS = 2000;
