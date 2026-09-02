"use client";

// PROTOTYPE — throwaway admin side of the preview bridge (#85). Mounted through
// `beforeDocumentControls`, renders nothing, reads form state only inside event handlers.

import { useDocumentInfo, useForm, useLivePreviewContext } from "@payloadcms/ui";
import type { FormState, Row } from "payload";
import { useEffect } from "react";

import {
  type BridgeMessage,
  HIGHLIGHT_ATTRIBUTE,
  isBridgeMessage,
  LOCATE_TIMEOUT_MS,
  MESSAGE_TYPE,
  VARIANT_ATTRIBUTE,
  type VariantKey,
} from "./protocol.ts";
import { ADMIN_CSS, type Variant, VARIANTS } from "./variants.ts";

type RowLocation = { index: number; path: string; row: Row };

const log = (...parts: unknown[]) => console.info("[lp-proto admin]", ...parts);

const rowDomId = (path: string, index: number) => `${path.split(".").join("-")}-row-${index}`;

const isVisible = (element: Element) => element.getClientRects().length > 0;

const isOffscreen = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return rect.top < 0 || rect.bottom > window.innerHeight;
};

const settle = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

/** Finds the blocks field and index whose row carries `id`. */
const findRow = (fields: FormState, id: string): RowLocation | undefined => {
  for (const [path, state] of Object.entries(fields)) {
    const index = state.rows?.findIndex((row) => row.id === id) ?? -1;
    const row = state.rows?.[index];
    if (row) return { index, path, row };
  }
  return undefined;
};

/** Every blocks row on the way to (and including) `rowPath`, outermost first. */
const rowsAlong = (fields: FormState, rowPath: string): RowLocation[] => {
  const segments = rowPath.split(".");
  const found: RowLocation[] = [];
  for (let i = 1; i < segments.length; i += 1) {
    const path = segments.slice(0, i).join(".");
    const index = Number(segments[i]);
    const row = fields[path]?.rows?.[index];
    if (row && Number.isInteger(index)) found.push({ index, path, row });
  }
  return found;
};

/** Reads the innermost-first chain of row ids around a DOM node, from form state. */
const rowChainFromElement = (target: Element | null, fields: FormState): string[] => {
  const ids: string[] = [];
  let rowElement = target?.closest(".blocks-field__row") ?? null;
  while (rowElement) {
    const wrapper = rowElement.parentElement;
    const index = Number(/-row-(\d+)$/.exec(wrapper?.id ?? "")?.[1]);
    const field = wrapper?.closest(".blocks-field") ?? null;
    const path = field?.id.replace(/^field-/, "").replaceAll("__", ".");
    const id = path === undefined ? undefined : fields[path]?.rows?.[index]?.id;
    if (id) ids.push(id);
    rowElement = field?.parentElement?.closest(".blocks-field__row") ?? null;
  }
  return ids;
};

const highlight = (element: Element, ms: number) => {
  element.removeAttribute(HIGHLIGHT_ATTRIBUTE);
  void (element as HTMLElement).offsetWidth; // restart the finite animation
  element.setAttribute(HIGHLIGHT_ATTRIBUTE, "");
  setTimeout(() => element.removeAttribute(HIGHLIGHT_ATTRIBUTE), ms);
};

/** Waits for a visible row element with one MutationObserver, bounded by LOCATE_TIMEOUT_MS. */
const waitForRow = (root: Node, domId: string) =>
  new Promise<HTMLElement | null>((resolve) => {
    const existing = document.getElementById(domId);
    if (existing && isVisible(existing)) return resolve(existing);
    const observer = new MutationObserver(() => {
      const element = document.getElementById(domId);
      if (element && isVisible(element)) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(element);
      }
    });
    const timer = setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, LOCATE_TIMEOUT_MS);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["style"],
      childList: true,
      subtree: true,
    });
  });

export const LinkingBridge = ({ debug = false }: { debug?: boolean }) => {
  const { iframeRef, isLivePreviewing, previewWindowType, url } = useLivePreviewContext();
  const { dispatchFields, formRef, getFields } = useForm();
  const { setDocFieldPreferences } = useDocumentInfo();

  useEffect(() => {
    const form = formRef.current;
    if (!isLivePreviewing || previewWindowType !== "iframe" || typeof url !== "string" || !form)
      return;

    const origin = new URL(url).origin;
    let connected = false;
    let variant: Variant = VARIANTS.A;
    let lastPostedId: string | null = null;
    const trace = debug ? log : () => {};

    const style = document.createElement("style");
    style.textContent = ADMIN_CSS;
    document.head.appendChild(style);
    document.documentElement.setAttribute(VARIANT_ATTRIBUTE, variant.key);

    const post = (message: BridgeMessage) =>
      iframeRef.current?.contentWindow?.postMessage(message, origin);

    const expand = (fields: FormState, location: RowLocation) => {
      const rows = fields[location.path]?.rows;
      if (!rows || !location.row.collapsed) return false;
      const updatedRows = rows.map((row, i) =>
        i === location.index ? { ...row, collapsed: false } : row,
      );
      dispatchFields({ type: "SET_ROW_COLLAPSED", path: location.path, updatedRows });
      setDocFieldPreferences(location.path, {
        collapsed: updatedRows.filter((row) => row.collapsed).map((row) => row.id),
      });
      return true;
    };

    const scrollTo = (element: Element) => {
      if (!isOffscreen(element)) return false;
      element.scrollIntoView({ behavior: variant.scrollBehavior, block: "center" });
      return true;
    };

    const reveal = async (element: HTMLElement) => {
      const rowElement = element.querySelector(".blocks-field__row") ?? element;
      const scrolled = scrollTo(element);
      if (variant.highlightAfter === "scrollend" && scrolled) await afterScroll();
      highlight(rowElement, variant.highlightMs);
    };

    const locate = async (ids: string[]) => {
      const started = performance.now();
      let fields = getFields();
      const target = ids.map((id) => findRow(fields, id)).find(Boolean);
      if (!target) return trace("locate: no row for", ids);
      const chain = rowsAlong(fields, `${target.path}.${target.index}`);
      const targetDomId = rowDomId(target.path, target.index);
      trace(
        `locate ${variant.key} (${variant.adminLocate})`,
        chain.map((c) => rowDomId(c.path, c.index)),
      );

      if (variant.adminLocate === "expand-then-scroll") {
        for (const location of chain) expand(fields, location);
        await settle(chain.some((c) => c.row.collapsed) ? 300 : 0);
      } else if (variant.adminLocate === "cascade") {
        for (const location of chain) {
          const element = await waitForRow(form, rowDomId(location.path, location.index));
          if (!element)
            return trace("cascade: timed out waiting for", rowDomId(location.path, location.index));
          scrollTo(element);
          fields = getFields();
          const current =
            rowsAlong(fields, `${location.path}.${location.index}`).at(-1) ?? location;
          if (expand(fields, current)) await settle(300);
        }
      } else {
        const deepestRendered = [...chain]
          .reverse()
          .map((c) => document.getElementById(rowDomId(c.path, c.index)))
          .find((element) => element && isVisible(element));
        if (deepestRendered) scrollTo(deepestRendered);
        for (const location of chain) expand(fields, location);
        await settle(chain.some((c) => c.row.collapsed) ? 300 : 0);
      }

      const element = await waitForRow(form, targetDomId);
      if (!element) return trace("locate: timed out waiting for", targetDomId);
      await reveal(element);
      trace(`revealed ${targetDomId} in ${Math.round(performance.now() - started)}ms`);
    };

    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.origin !== origin) return;
      if (!isBridgeMessage(event.data)) return;
      if (event.data.event === "ready") {
        if (connected) return;
        connected = true;
        post({ type: MESSAGE_TYPE, event: "ready" });
        trace("connected");
      } else if (event.data.event === "variant") {
        variant = VARIANTS[event.data.variant as VariantKey];
        document.documentElement.setAttribute(VARIANT_ATTRIBUTE, variant.key);
        trace("variant", variant.key, variant.name);
      } else if (connected) {
        void locate(event.data.ids);
      }
    };

    const onFocusOrClick = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      const ids = rowChainFromElement(target, getFields());
      if (ids.length === 0) return;
      const isHeader = Boolean(target?.closest(".collapsible__toggle-wrap"));
      if (!isHeader && ids[0] === lastPostedId) return;
      lastPostedId = ids[0] ?? null;
      if (!connected) return trace("locate dropped, not connected", ids);
      post({ type: MESSAGE_TYPE, event: "locate", ids });
      trace(`${event.type} → locate`, ids);
    };

    window.addEventListener("message", onMessage);
    form.addEventListener("focusin", onFocusOrClick);
    form.addEventListener("click", onFocusOrClick);
    post({ type: MESSAGE_TYPE, event: "ready" });

    return () => {
      window.removeEventListener("message", onMessage);
      form.removeEventListener("focusin", onFocusOrClick);
      form.removeEventListener("click", onFocusOrClick);
      style.remove();
      document.documentElement.removeAttribute(VARIANT_ATTRIBUTE);
    };
  }, [
    debug,
    dispatchFields,
    formRef,
    getFields,
    iframeRef,
    isLivePreviewing,
    previewWindowType,
    setDocFieldPreferences,
    url,
  ]);

  return null;
};
