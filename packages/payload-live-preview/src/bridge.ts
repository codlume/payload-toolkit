import { connect, diagnostics } from "./channel.ts";
import { createLocateWork } from "./locate.ts";
import { createVisuals } from "./visuals.ts";

export type BridgeOptions = { serverURL: string; debug?: boolean };
const markedAncestors = (target: EventTarget | null) => {
  const elements: HTMLElement[] = [];
  let element =
    target instanceof Element ? target.closest<HTMLElement>("[data-payload-block]") : null;
  while (element) {
    elements.push(element);
    element = element.parentElement?.closest<HTMLElement>("[data-payload-block]") ?? null;
  }
  return elements;
};

let active: { count: number; dispose: () => void } | undefined;

/** Connects only inside an iframe. Dispose every registration on unmount. */
export const createPreviewBridge = ({ serverURL, debug = false }: BridgeOptions): (() => void) => {
  if (typeof window === "undefined" || window.parent === window) return () => {};
  let origin: string;
  try {
    origin = new URL(serverURL).origin;
  } catch {
    return () => {};
  }
  if (!active) {
    const log = diagnostics("preview", debug);
    const work = createLocateWork(log);
    let visuals: ReturnType<typeof createVisuals> | undefined;
    const click = (event: MouseEvent) => {
      const ids = markedAncestors(event.target)
        .map((element) => element.dataset.payloadBlock!)
        .filter(Boolean);
      if (ids.length) channel.locate(ids);
    };
    const pointerover = (event: PointerEvent) =>
      visuals?.hover(markedAncestors(event.target)[0] ?? null);
    const pointerout = (event: PointerEvent) => {
      if (!event.relatedTarget) visuals?.hover(null);
    };
    const channel = connect({
      peer: window.parent,
      origin,
      log,
      onConnect() {
        visuals = createVisuals();
        document.addEventListener("click", click, true);
        document.addEventListener("pointerover", pointerover);
        document.addEventListener("pointerout", pointerout);
      },
      onPeerReady() {
        work.cancel();
        visuals?.cancelReveal();
      },
      onLocate(ids) {
        visuals?.cancelReveal();
        work.locate(ids, () => {
          for (const [index, id] of ids.entries()) {
            const target = Array.from(
              document.querySelectorAll<HTMLElement>("[data-payload-block]"),
            ).find(
              (element) =>
                element.dataset.payloadBlock === id &&
                element.getClientRects().length > 0 &&
                getComputedStyle(element).visibility === "visible" &&
                (!element.checkVisibility ||
                  element.checkVisibility({ opacityProperty: true, visibilityProperty: true })),
            );
            if (target) {
              if (index) log("ancestor fallback", ids);
              visuals?.reveal(target);
              return true;
            }
          }
          return false;
        });
      },
    });
    active = {
      count: 0,
      dispose() {
        work.cancel();
        channel.dispose();
        visuals?.dispose();
        document.removeEventListener("click", click, true);
        document.removeEventListener("pointerover", pointerover);
        document.removeEventListener("pointerout", pointerout);
      },
    };
  }
  const instance = active;
  instance.count++;
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (--instance.count === 0) {
      instance.dispose();
      active = undefined;
    }
  };
};
