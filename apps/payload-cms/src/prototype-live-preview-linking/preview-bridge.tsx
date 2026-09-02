"use client";

// PROTOTYPE — throwaway preview side of the bridge (#85) plus the variant switcher.
// Inert unless inside an iframe; installs click listener and styles only once connected.

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import {
  type BridgeMessage,
  HIGHLIGHT_ATTRIBUTE,
  HOVER_ATTRIBUTE,
  isBridgeMessage,
  isVariantKey,
  LOCATE_TIMEOUT_MS,
  MESSAGE_TYPE,
  VARIANT_ATTRIBUTE,
  VARIANT_KEYS,
  type VariantKey,
} from "./protocol.ts";
import { PREVIEW_CSS, VARIANTS } from "./variants.ts";

type BridgeState = { connected: boolean; inIframe: boolean; log: string[] };

const isOffscreen = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.top < 0 || rect.bottom > window.innerHeight;
};

const afterScroll = (ms = 700) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    document.addEventListener(
      "scrollend",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { capture: true, once: true },
    );
  });

const findMarked = (ids: string[]) => {
  for (const id of ids) {
    const element = document.querySelector(`[data-payload-block="${CSS.escape(id)}"]`);
    if (element) return element;
  }
  return null;
};

const markerChain = (target: Element | null) => {
  const ids: string[] = [];
  let element = target?.closest("[data-payload-block]") ?? null;
  while (element) {
    const id = element.getAttribute("data-payload-block");
    if (id) ids.push(id);
    element = element.parentElement?.closest("[data-payload-block]") ?? null;
  }
  return ids;
};

export const PreviewBridge = ({ serverURL }: { serverURL: string }) => {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requested = searchParams.get("variant");
  const variantKey: VariantKey = isVariantKey(requested) ? requested : "A";
  const variant = VARIANTS[variantKey];
  const variantRef = useRef(variant);
  variantRef.current = variant;
  const postRef = useRef<((message: BridgeMessage) => void) | null>(null);
  const [state, setState] = useState<BridgeState>({ connected: false, inIframe: false, log: [] });
  const note = (line: string) =>
    setState((previous) => ({ ...previous, log: [line, ...previous.log].slice(0, 4) }));

  useEffect(() => {
    if (window.parent === window) return;
    setState((previous) => ({ ...previous, inIframe: true }));
    const origin = new URL(serverURL).origin;
    let connected = false;
    let pending: { observer: MutationObserver; timer: number } | null = null;
    let style: HTMLStyleElement | null = null;

    const post = (message: BridgeMessage) => window.parent.postMessage(message, origin);
    postRef.current = post;

    const highlight = (element: Element) => {
      element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
      void (element as HTMLElement).offsetWidth;
      element.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
      setTimeout(
        () => element.removeAttribute(HIGHLIGHT_ATTRIBUTE),
        variantRef.current.highlightMs,
      );
    };

    const reveal = async (element: Element, started: number) => {
      const current = variantRef.current;
      const scrolled = isOffscreen(element);
      if (scrolled) element.scrollIntoView({ behavior: current.scrollBehavior, block: "center" });
      if (current.highlightAfter === "scrollend" && scrolled) await afterScroll();
      highlight(element);
      note(
        `revealed ${element.getAttribute("data-payload-block")} in ${Math.round(performance.now() - started)}ms`,
      );
    };

    const locate = (ids: string[]) => {
      const started = performance.now();
      if (pending) {
        pending.observer.disconnect();
        clearTimeout(pending.timer);
        pending = null;
      }
      const found = findMarked(ids);
      if (found) return void reveal(found, started);
      const observer = new MutationObserver(() => {
        const late = findMarked(ids);
        if (!late) return;
        observer.disconnect();
        if (pending) clearTimeout(pending.timer);
        pending = null;
        void reveal(late, started);
      });
      const timer = window.setTimeout(() => {
        observer.disconnect();
        pending = null;
        note(`locate dropped, nothing marked for ${ids.join(", ")}`);
      }, LOCATE_TIMEOUT_MS);
      observer.observe(document.body, { childList: true, subtree: true });
      pending = { observer, timer };
    };

    const onClick = (event: MouseEvent) => {
      const ids = markerChain(event.target instanceof Element ? event.target : null);
      if (ids.length === 0) return;
      post({ type: MESSAGE_TYPE, event: "locate", ids });
      note(`click → locate ${ids.join(" ‹ ")}`);
    };

    const connect = () => {
      connected = true;
      style = document.createElement("style");
      style.textContent = PREVIEW_CSS;
      document.head.appendChild(style);
      document.addEventListener("click", onClick, true);
      post({ type: MESSAGE_TYPE, event: "variant", variant: variantRef.current.key });
      setState((previous) => ({ ...previous, connected: true }));
      note("connected");
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      if (!isBridgeMessage(event.data)) return;
      if (event.data.event === "ready") {
        if (connected) return;
        connect();
        post({ type: MESSAGE_TYPE, event: "ready" });
      } else if (event.data.event === "locate" && connected) {
        note(`locate ← ${event.data.ids.join(" ‹ ")}`);
        locate(event.data.ids);
      }
    };

    window.addEventListener("message", onMessage);
    post({ type: MESSAGE_TYPE, event: "ready" });

    return () => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("click", onClick, true);
      style?.remove();
      postRef.current = null;
    };
  }, [serverURL]);

  useEffect(() => {
    document.documentElement.setAttribute(VARIANT_ATTRIBUTE, variant.key);
    postRef.current?.({ type: MESSAGE_TYPE, event: "variant", variant: variant.key });
    if (variant.hover !== "delegated") return;
    let hovered: Element | null = null;
    const onPointerOver = (event: PointerEvent) => {
      const next =
        event.target instanceof Element ? event.target.closest("[data-payload-block]") : null;
      if (next === hovered) return;
      hovered?.removeAttribute(HOVER_ATTRIBUTE);
      next?.setAttribute(HOVER_ATTRIBUTE, "");
      hovered = next;
    };
    document.addEventListener("pointerover", onPointerOver);
    return () => {
      document.removeEventListener("pointerover", onPointerOver);
      hovered?.removeAttribute(HOVER_ATTRIBUTE);
    };
  }, [variant]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const active = document.activeElement;
      if (
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement ||
        active?.hasAttribute("contenteditable")
      )
        return;
      cycle(event.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const cycle = (step: number) => {
    const index = VARIANT_KEYS.indexOf(variant.key);
    const next = VARIANT_KEYS[(index + step + VARIANT_KEYS.length) % VARIANT_KEYS.length] ?? "A";
    router.replace(`?variant=${next}`, { scroll: false });
  };

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div className="lp-switcher" role="toolbar" aria-label="Prototype variant">
      <div className="lp-switcher__row">
        <button type="button" onClick={() => cycle(-1)} aria-label="Previous variant">
          ←
        </button>
        <strong>
          {variant.key} — {variant.name}
        </strong>
        <button type="button" onClick={() => cycle(1)} aria-label="Next variant">
          →
        </button>
      </div>
      <p className="lp-switcher__summary">{variant.summary}</p>
      <p className="lp-switcher__state">
        {state.inIframe
          ? state.connected
            ? "bridge connected"
            : "in iframe, waiting for admin"
          : "not in an iframe, bridge inert"}
        {" · "}highlight {variant.highlightMs}ms · hover {variant.hover} · admin{" "}
        {variant.adminLocate}
      </p>
      {state.log.map((line, i) => (
        <p key={`${i}-${line}`} className="lp-switcher__log">
          {line}
        </p>
      ))}
    </div>
  );
};
