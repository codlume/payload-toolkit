"use client";
import { useDocumentInfo, useForm, useLivePreviewContext } from "@payloadcms/ui";
import { useEffect, useRef } from "react";
import { connect, diagnostics } from "./channel.ts";
import { createVisuals } from "./visuals.ts";

/** Mounted by the plugin in native edit controls. Reads fields only on selection. */
export const PreviewBridgeAdmin = ({ debug = false }: { debug?: boolean }) => {
  const preview = useLivePreviewContext();
  const form = useForm();
  const { setDocFieldPreferences } = useDocumentInfo();
  const current = useRef({ form, setDocFieldPreferences });
  current.current = { form, setDocFieldPreferences };
  const { iframeRef, isLivePreviewing, previewWindowType, url, loadedURL } = preview;
  useEffect(() => {
    const iframe = iframeRef.current;
    const formElement = current.current.form.formRef.current;
    if (
      !isLivePreviewing ||
      previewWindowType !== "iframe" ||
      typeof url !== "string" ||
      !url ||
      !iframe?.contentWindow ||
      !formElement
    )
      return undefined;
    let origin: string;
    try {
      origin = new URL(url, window.location.href).origin;
    } catch {
      return undefined;
    }
    const log = diagnostics("admin", debug);
    let visuals: ReturnType<typeof createVisuals> | undefined;
    let selected: string | undefined;
    const rows = () =>
      Object.entries(current.current.form.getFields()).flatMap(([path, field]) =>
        (field.rows ?? []).flatMap((row, index) => {
          if (!row.blockType || !row.id) return [];
          const element = document
            .getElementById(`${path.replaceAll(".", "-")}-row-${index}`)
            ?.querySelector<HTMLElement>(".blocks-field__row");
          return [{ row, path, index, element }];
        }),
      );
    const select = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      // The toggle gets focus before its click; the click sends the single row-header locate.
      if (event.type === "focusin" && target.closest(".collapsible__toggle")) return;
      const matches = rows()
        .filter(({ element }) => element?.contains(target))
        .toReversed();
      const ids = matches.map(({ row }) => row.id);
      const id = ids[0];
      const header = event.type === "click" && !!target.closest(".collapsible__toggle-wrap");
      if (id && (id !== selected || header) && channel.locate(ids)) selected = id;
    };
    const start = () =>
      connect({
        peer: iframe.contentWindow!,
        origin,
        log,
        onConnect() {
          visuals = createVisuals();
          formElement.addEventListener("focusin", select);
          formElement.addEventListener("click", select);
        },
        onLocate(ids) {
          const available = rows();
          for (const [index, id] of ids.entries()) {
            const target = available.find(({ row, element }) => row.id === id && element);
            if (!target?.element) continue;
            if (index) log("ancestor fallback", ids);
            if (target.row.collapsed) {
              const field = current.current.form.getFields()[target.path];
              // oxlint-disable-next-line oxc/no-map-spread -- Payload reducers require immutable row updates
              const updatedRows = (field?.rows ?? []).map((row) =>
                row.id === id ? { ...row, collapsed: false } : row,
              );
              current.current.form.dispatchFields({
                type: "SET_ROW_COLLAPSED",
                path: target.path,
                updatedRows,
              });
              current.current.setDocFieldPreferences(target.path, {
                collapsed: updatedRows.filter((row) => row.collapsed).map((row) => row.id),
              });
            }
            visuals?.reveal(target.element);
            return;
          }
          log("missing target", ids);
        },
      });
    let channel = start();
    const reset = () => {
      channel.dispose();
      visuals?.dispose();
      visuals = undefined;
      selected = undefined;
      formElement.removeEventListener("focusin", select);
      formElement.removeEventListener("click", select);
    };
    const reload = () => {
      reset();
      channel = start();
    };
    iframe.addEventListener("load", reload);
    return () => {
      reset();
      iframe.removeEventListener("load", reload);
    };
  }, [debug, iframeRef, isLivePreviewing, previewWindowType, url, loadedURL]);
  return null;
};
