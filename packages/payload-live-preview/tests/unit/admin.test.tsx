// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import { PreviewBridgeAdmin } from "../../src/client.tsx";

const context = vi.hoisted(() => ({
  locale: { code: "en" },
  preview: {
    iframeRef: { current: null as HTMLIFrameElement | null },
    isLivePreviewing: true,
    previewWindowType: "iframe",
    url: "https://preview.example/page",
    loadedURL: "https://preview.example/page",
  },
  form: {
    formRef: { current: null as HTMLFormElement | null },
    getFields: vi.fn(() => ({ layout: { rows: [{ id: "one", blockType: "text" }] } })),
  },
}));
// Payload's context is the external adapter boundary; exercise the exported component.
vi.mock("@payloadcms/ui", () => ({
  useLivePreviewContext: () => context.preview,
  useForm: () => context.form,
  useDocumentInfo: () => ({ setDocFieldPreferences: vi.fn() }),
  useLocale: () => context.locale,
}));

const cleanups: (() => void)[] = [];
afterEach(() => {
  act(() => cleanups.splice(0).forEach((cleanup) => cleanup()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  context.preview.isLivePreviewing = true;
  context.preview.url = "https://preview.example/page";
  context.preview.previewWindowType = "iframe";
  context.locale.code = "en";
  context.form.getFields.mockReturnValue({ layout: { rows: [{ id: "one", blockType: "text" }] } });
});

const receive = (data: unknown, source = context.preview.iframeRef.current!.contentWindow!) =>
  window.dispatchEvent(
    new MessageEvent("message", { data, source, origin: "https://preview.example" }),
  );

const setup = (debug = false) => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  document.body.innerHTML =
    '<div id="mount"></div><form><div id="layout-row-0"><div class="blocks-field__row"><input /></div></div></form><iframe></iframe>';
  context.form.formRef.current = document.querySelector("form");
  context.preview.iframeRef.current = document.querySelector("iframe");
  const peer = context.preview.iframeRef.current!.contentWindow!;
  const post = vi.spyOn(peer, "postMessage").mockReturnValue(undefined);
  const root = createRoot(document.querySelector("#mount")!);
  cleanups.push(() => root.unmount());
  const render = () => act(() => root.render(<PreviewBridgeAdmin debug={debug} />));
  render();
  return { post, peer, render, message: receive, input: document.querySelector("input")! };
};
const ready = { type: "@codlume/payload-live-preview", event: "ready" };

test("locale changes cancel pending work and renew selection against current fields without navigation", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "debug").mockReturnValue(undefined);
  const { message, post, render, input } = setup();
  message(ready);
  input.focus();
  message({ ...ready, event: "locate", ids: ["translated"] });
  context.locale.code = "pl";
  render();
  post.mockClear();
  message({ ...ready, ack: true });
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(post.mock.calls).toEqual([
    [{ ...ready, event: "locate", ids: ["one"] }, "https://preview.example"],
  ]);
  context.form.getFields.mockReturnValue({
    layout: { rows: [{ id: "translated", blockType: "text" }] },
  });
  document.querySelector(".blocks-field__row")!.setAttribute("data-locale", "pl");
  await vi.advanceTimersByTimeAsync(2100);
  expect(document.querySelector("[data-payload-block-highlight]")).toBeNull();
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(post).toHaveBeenLastCalledWith(
    { ...ready, event: "locate", ids: ["translated"] },
    "https://preview.example",
  );
  expect(log).not.toHaveBeenCalled();
});

test.each([false, true])(
  "unavailable conditional URLs and popup previews stay inert with debug=%s",
  (debug) => {
    const log = vi.spyOn(console, "debug").mockReturnValue(undefined);
    context.preview.url = "";
    const { post, render, message, input } = setup(debug);
    message(ready);
    input.focus();
    expect(post).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
    context.preview.url = "https://preview.example/page?secret=document-content";
    render();
    message(ready);
    expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(true);
    context.preview.previewWindowType = "popup";
    render();
    post.mockClear();
    message(ready);
    input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    expect(post).not.toHaveBeenCalled();
    expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
    if (debug) {
      expect(log).toHaveBeenCalledWith(
        "[@codlume/payload-live-preview:admin] unavailable preview context",
      );
      expect(log).toHaveBeenCalledWith("[@codlume/payload-live-preview:admin] reset");
      expect(JSON.stringify(log.mock.calls)).not.toContain("document-content");
    } else expect(log).not.toHaveBeenCalled();
  },
);

test("iframe replacement reconnects even when Payload retains the ref and URL", () => {
  const { render, message, post, peer, input } = setup();
  message(ready);
  input.focus();
  expect(post).toHaveBeenLastCalledWith(
    { ...ready, event: "locate", ids: ["one"] },
    "https://preview.example",
  );
  const replacement = document.createElement("iframe");
  context.preview.iframeRef.current!.replaceWith(replacement);
  context.preview.iframeRef.current = replacement;
  const nextPost = vi.spyOn(replacement.contentWindow!, "postMessage").mockReturnValue(undefined);
  render();
  expect(nextPost).toHaveBeenCalledWith(ready, "https://preview.example");
  message(ready, peer);
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  message(ready);
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(nextPost).toHaveBeenLastCalledWith(
    { ...ready, event: "locate", ids: ["one"] },
    "https://preview.example",
  );
});

test("same-URL iframe loads clear selection and drop disconnected requests without replay", () => {
  const { message, post, input } = setup();
  message(ready);
  input.focus();
  context.form.getFields.mockClear();
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  expect(context.form.getFields).not.toHaveBeenCalled();
  context.preview.iframeRef.current!.dispatchEvent(new Event("load"));
  post.mockClear();
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  message({ ...ready, event: "locate", ids: ["one"] });
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  message({ ...ready, ack: true });
  expect(post).not.toHaveBeenCalled();
  expect(document.querySelector("[data-payload-block-highlight]")).toBeNull();
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(post.mock.calls).toEqual([
    [{ ...ready, event: "locate", ids: ["one"] }, "https://preview.example"],
  ]);
});

test("closing preview cancels pending work and reopening requires a fresh handshake", () => {
  const { message, post, render, input } = setup();
  message(ready);
  input.focus();
  message({ ...ready, event: "locate", ids: ["missing"] });
  context.preview.isLivePreviewing = false;
  render();
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  expect(document.head.querySelector("style")).toBeNull();
  context.preview.isLivePreviewing = true;
  render();
  post.mockClear();
  message({ ...ready, ack: true });
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(post.mock.calls).toEqual([
    [{ ...ready, event: "locate", ids: ["one"] }, "https://preview.example"],
  ]);
});

test("URL navigation cancels pending locates and forgets the previous selection", () => {
  const { message, post, render, input } = setup();
  message(ready);
  input.focus();
  message({ ...ready, event: "locate", ids: ["missing"] });
  context.preview.url = "https://preview.example/another-page";
  render();
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  post.mockClear();
  message({ ...ready, ack: true });
  input.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
  expect(post.mock.calls).toEqual([
    [{ ...ready, event: "locate", ids: ["one"] }, "https://preview.example"],
  ]);
});
