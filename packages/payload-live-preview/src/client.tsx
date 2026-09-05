"use client";
import { useDocumentInfo, useForm, useLivePreviewContext } from "@payloadcms/ui";
import { useEffect, useRef } from "react";
import { connect, diagnostics } from "./channel.ts";
import { createLocateWork } from "./locate.ts";
import { createVisuals } from "./visuals.ts";

/** Mounted by the plugin in native edit controls. Reads fields only on selection. */
export const PreviewBridgeAdmin = ({ debug = false }: { debug?: boolean }) => {
  const preview = useLivePreviewContext();
  const form = useForm();
  const { setDocFieldPreferences } = useDocumentInfo();
  const current = useRef({ form, setDocFieldPreferences });
  current.current = { form, setDocFieldPreferences };
  const { iframeRef, isLivePreviewing, previewWindowType, url, loadedURL } = preview;
  const iframeElement = iframeRef.current;
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
    const work = createLocateWork(log);
    let visuals: ReturnType<typeof createVisuals> | undefined;
    let selected: string | undefined;
    const rows = () => {
      const fields = current.current.form.getFields();
      return Object.entries(fields).flatMap(([path, field]) => {
        if (!field.rows) return [];
        // Payload can retain descendant state after a parent condition becomes false.
        let ancestor = path;
        while (ancestor) {
          if (fields[ancestor]?.passesCondition === false) return [];
          const separator = ancestor.lastIndexOf(".");
          ancestor = separator === -1 ? "" : ancestor.slice(0, separator);
        }
        return field.rows.flatMap((row, index) => {
          if (!row.blockType || !row.id) return [];
          const element = document
            .getElementById(`${path.replaceAll(".", "-")}-row-${index}`)
            ?.querySelector<HTMLElement>(".blocks-field__row");
          return [{ row, path, index, element }];
        });
      });
    };
    const select = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const target = event.target;
      // The toggle gets focus before its click; the click sends the single row-header locate.
      if (event.type === "focusin" && target.closest(".collapsible__toggle")) return;
      const matches = rows()
        .filter(({ element }) => element?.contains(target))
        .toSorted((a, b) => b.path.split(".").length - a.path.split(".").length);
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
          visuals?.cancelReveal();
          const visited = new Set<string>();
          let fallbackLogged = false;
          work.locate(ids, () => {
            const available = rows();
            const id = ids.find((candidate) => available.some(({ row }) => row.id === candidate));
            const target = available.find(({ row }) => row.id === id);
            if (!target) return false;
            if (id !== ids[0] && !fallbackLogged) {
              log("ancestor fallback", ids);
              fallbackLogged = true;
            }
            const targetPath = `${target.path}.${target.index}`;
            const ancestors = available
              .filter(({ path, index }) => {
                const rowPath = `${path}.${index}`;
                return targetPath === rowPath || targetPath.startsWith(`${rowPath}.`);
              })
              .toSorted((a, b) => a.path.split(".").length - b.path.split(".").length);
            for (const ancestor of ancestors) {
              if (!ancestor.element) return false;
              if (!visited.has(ancestor.row.id)) {
                visuals?.scroll(ancestor.element);
                visited.add(ancestor.row.id);
              }
              if (ancestor.row.collapsed) {
                const field = current.current.form.getFields()[ancestor.path];
                // oxlint-disable-next-line oxc/no-map-spread -- Payload reducers require immutable row updates
                const updatedRows = (field?.rows ?? []).map((row) =>
                  row.id === ancestor.row.id ? { ...row, collapsed: false } : row,
                );
                current.current.form.dispatchFields({
                  type: "SET_ROW_COLLAPSED",
                  path: ancestor.path,
                  updatedRows,
                });
                current.current.setDocFieldPreferences(ancestor.path, {
                  collapsed: updatedRows.filter((row) => row.collapsed).map((row) => row.id),
                });
                return 300;
              }
            }
            if (!target.element) return false;
            visuals?.reveal(target.element);
            return true;
          });
        },
      });
    let channel = start();
    const reset = () => {
      work.cancel();
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
  }, [debug, iframeRef, iframeElement, isLivePreviewing, previewWindowType, url, loadedURL]);
  return null;
};
