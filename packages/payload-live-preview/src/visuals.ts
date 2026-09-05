const noop = () => {};
const onScreen = (element: HTMLElement) => {
  const rect = element.getBoundingClientRect();
  return (
    rect.top >= 0 &&
    rect.left >= 0 &&
    rect.bottom <= window.innerHeight &&
    rect.right <= window.innerWidth
  );
};
const scroll = (element: HTMLElement) =>
  element.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
const root = "data-payload-linking";
const hover = "data-payload-block-hover";
const highlight = "data-payload-block-highlight";

/** A connected adapter owns one stylesheet, hover target, and pending highlight. */
export const createVisuals = () => {
  const style = document.createElement("style");
  style.textContent = `
[${root}] [${hover}] { outline: 2px dashed #635bff; outline-offset: 2px; cursor: pointer; }
[${root}] [${hover}]::before { content: attr(data-payload-block-type); position: absolute; top: 0; left: 0; padding: 3px 7px; border-radius: 3px; background: #635bff; color: white; font: 11px/1.4 sans-serif; text-transform: uppercase; pointer-events: none; z-index: 2; }
[${root}] [${hover}]::after, [${root}] [${highlight}]::after { content: ''; position: absolute; inset: 0; border-radius: inherit; background: #635bff; pointer-events: none; opacity: 0; }
[${root}] [${hover}]::after { opacity: .08; animation: payload-link-hover 150ms ease-out; }
[${root}] [${highlight}]::after { animation: payload-link-highlight 1200ms ease-out forwards; }
@keyframes payload-link-hover { from { opacity: 0; } to { opacity: .08; } }
@keyframes payload-link-highlight { from { opacity: .35; } to { opacity: 0; } }
`;
  document.head.append(style);
  document.documentElement.setAttribute(root, "");
  const positions = new Map<HTMLElement, { value: string; priority: string }>();
  let hovered: HTMLElement | null = null;
  let highlighted: HTMLElement | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancelScroll = noop;
  const position = (element: HTMLElement) => {
    if (!positions.has(element) && getComputedStyle(element).position === "static") {
      positions.set(element, {
        value: element.style.getPropertyValue("position"),
        priority: element.style.getPropertyPriority("position"),
      });
      element.style.position = "relative";
    }
  };
  const restore = (element: HTMLElement) => {
    const previous = positions.get(element);
    if (previous && !element.hasAttribute(hover) && !element.hasAttribute(highlight)) {
      if (previous.value) element.style.setProperty("position", previous.value, previous.priority);
      else element.style.removeProperty("position");
      positions.delete(element);
    }
  };
  const clearHighlight = () => {
    clearTimeout(timer);
    if (highlighted) {
      highlighted.removeAttribute(highlight);
      restore(highlighted);
      highlighted = null;
    }
  };
  const flash = (element: HTMLElement) => {
    clearHighlight();
    position(element);
    // Flush the removed finite animation so selecting the same row restarts it.
    void element.offsetWidth;
    element.setAttribute(highlight, "");
    highlighted = element;
    timer = setTimeout(clearHighlight, 1200);
  };
  return {
    hover(element: HTMLElement | null) {
      if (element === hovered) return;
      if (hovered) {
        hovered.removeAttribute(hover);
        restore(hovered);
      }
      hovered = element;
      if (element) {
        position(element);
        element.setAttribute(hover, "");
      }
    },
    cancelReveal() {
      cancelScroll();
      clearHighlight();
    },
    scroll(element: HTMLElement) {
      if (!onScreen(element)) scroll(element);
    },
    reveal(element: HTMLElement) {
      cancelScroll();
      clearHighlight();
      if (onScreen(element)) {
        flash(element);
        return;
      }
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        cancelScroll();
        flash(element);
      };
      const fallback = setTimeout(finish, 700);
      document.addEventListener("scrollend", finish, true);
      cancelScroll = () => {
        clearTimeout(fallback);
        document.removeEventListener("scrollend", finish, true);
        cancelScroll = noop;
      };
      scroll(element);
    },
    dispose() {
      cancelScroll();
      clearHighlight();
      if (hovered) {
        hovered.removeAttribute(hover);
        restore(hovered);
      }
      style.remove();
      document.documentElement.removeAttribute(root);
    },
  };
};
