// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { createPreviewBridge } from "../../src/core.ts";

const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const setupPeer = (debug = false) => {
  // jsdom has no layout; browser scenarios exercise real visibility and scrolling.
  vi.spyOn(Element.prototype, "getClientRects").mockReturnValue(
    Object.assign([new DOMRect()], { item: () => null }),
  );
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const parent = Object.assign(frame.contentWindow!, { postMessage: vi.fn() });
  vi.spyOn(window, "parent", "get").mockReturnValue(parent);
  document.body.insertAdjacentHTML(
    "beforeend",
    '<p data-payload-block="one" data-payload-block-type="text">Hello</p>',
  );
  const dispose = createPreviewBridge({ serverURL: "https://admin.example", debug });
  disposers.push(dispose);
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- the default source is this test peer
  const message = (data: unknown, origin = "https://admin.example", source: Window = parent) =>
    window.dispatchEvent(new MessageEvent("message", { data, origin, source: source }));
  return { parent, dispose, message, element: document.querySelector("p")! };
};

test("iframe interaction stays inactive until an origin/source-validated ready request", () => {
  const { parent, element, message } = setupPeer();
  expect(parent.postMessage).toHaveBeenCalledWith(
    { type: "@codlume/payload-live-preview", event: "ready" },
    "https://admin.example",
  );
  element.click();
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  message({ type: "@codlume/payload-live-preview", event: "ready" });
  element.click();
  expect(parent.postMessage.mock.calls.slice(1)).toEqual([
    [{ type: "@codlume/payload-live-preview", event: "ready", ack: true }, "https://admin.example"],
    [
      { type: "@codlume/payload-live-preview", event: "locate", ids: ["one"] },
      "https://admin.example",
    ],
  ]);
});

const ready = { type: "@codlume/payload-live-preview", event: "ready" };

test("invalid plugin messages and unrelated native traffic never activate linking", () => {
  const log = vi.spyOn(console, "debug");
  const { parent, message, element } = setupPeer();
  message(ready, "https://attacker.example");
  message(ready, "https://admin.example", window);
  message({ ...ready, ack: false });
  message({ ...ready, event: "locate", ids: [1] });
  message({ ...ready, event: "locate", ids: ["one"] });
  message({ type: "payload-live-preview", event: "ready" });
  element.click();
  expect(parent.postMessage.mock.calls).toEqual([[ready, "https://admin.example"]]);
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  expect(log).not.toHaveBeenCalled();
});

test("requests always get one acknowledgement and acknowledgements never get replies", () => {
  const { parent, message } = setupPeer();
  message(ready);
  message(ready);
  message({ ...ready, ack: true });
  expect(parent.postMessage.mock.calls).toEqual([
    [ready, "https://admin.example"],
    [{ ...ready, ack: true }, "https://admin.example"],
    [{ ...ready, ack: true }, "https://admin.example"],
  ]);
});

test("an acknowledgement alone connects and nested registrations share final cleanup", () => {
  const { parent, message, element, dispose } = setupPeer();
  const second = createPreviewBridge({ serverURL: "https://admin.example" });
  disposers.push(second);
  message({ ...ready, ack: true });
  dispose();
  element.click();
  expect(parent.postMessage.mock.calls.at(-1)).toEqual([
    { ...ready, event: "locate", ids: ["one"] },
    "https://admin.example",
  ]);
  second();
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
  expect(document.head.querySelector("style")).toBeNull();
  parent.postMessage.mockClear();
  element.click();
  message(ready);
  expect(parent.postMessage).not.toHaveBeenCalled();
});

test("diagnostics omit native messages and rejected payload contents", () => {
  const log = vi.spyOn(console, "debug");
  const { message } = setupPeer(true);
  message({ type: "payload-live-preview", secret: "document content" });
  message({ ...ready, ack: false, content: "private data" });
  message(ready);
  message({ ...ready, event: "locate", ids: ["absent"] });
  expect(log.mock.calls).toEqual([
    ["[@codlume/payload-live-preview:preview] rejected plugin message: malformed payload"],
    ["[@codlume/payload-live-preview:preview] connected"],
    ["[@codlume/payload-live-preview:preview] received locate", ["absent"]],
    ["[@codlume/payload-live-preview:preview] missing target", ["absent"]],
  ]);
});

test("standalone pages never send a handshake or install styles", () => {
  const post = vi.spyOn(window, "postMessage");
  disposers.push(createPreviewBridge({ serverURL: "https://admin.example" }));
  expect(post).not.toHaveBeenCalled();
  expect(document.documentElement.hasAttribute("data-payload-linking")).toBe(false);
});

test("locates wait for rendering, replace older requests and expire after two seconds", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "debug");
  const { message, dispose } = setupPeer(true);
  message(ready);
  message({ ...ready, event: "locate", ids: ["old"] });
  message({ ...ready, event: "locate", ids: ["new"] });
  document.body.insertAdjacentHTML(
    "beforeend",
    '<p data-payload-block="old">Old</p><p data-payload-block="new">New</p>',
  );
  await Promise.resolve();
  expect(
    document
      .querySelector('[data-payload-block="new"]')
      ?.hasAttribute("data-payload-block-highlight"),
  ).toBe(true);
  expect(
    document
      .querySelector('[data-payload-block="old"]')
      ?.hasAttribute("data-payload-block-highlight"),
  ).toBe(false);
  message({ ...ready, event: "locate", ids: ["late"] });
  await vi.advanceTimersByTimeAsync(2000);
  expect(log).toHaveBeenCalledWith("[@codlume/payload-live-preview:preview] target timeout", [
    "late",
  ]);
  document.body.insertAdjacentHTML("beforeend", '<p data-payload-block="late">Late</p>');
  await Promise.resolve();
  expect(
    document
      .querySelector('[data-payload-block="late"]')
      ?.hasAttribute("data-payload-block-highlight"),
  ).toBe(false);
  message({ ...ready, event: "locate", ids: ["disposed"] });
  dispose();
  document.body.insertAdjacentHTML("beforeend", '<p data-payload-block="disposed">Disposed</p>');
  await vi.advanceTimersByTimeAsync(2000);
  expect(
    document
      .querySelector('[data-payload-block="disposed"]')
      ?.hasAttribute("data-payload-block-highlight"),
  ).toBe(false);
});

test("hidden inner markers fall back to an enclosing block and clicks send innermost-first ids", () => {
  const { message, parent, element } = setupPeer();
  element.innerHTML = '<span data-payload-block="inner" style="visibility:hidden">Inner</span>';
  message(ready);
  message({ ...ready, event: "locate", ids: ["inner", "one"] });
  expect(element.hasAttribute("data-payload-block-highlight")).toBe(true);
  element.querySelector("span")!.click();
  expect(parent.postMessage).toHaveBeenLastCalledWith(
    { ...ready, event: "locate", ids: ["inner", "one"] },
    "https://admin.example",
  );
});

test("hover and repeated highlights restore inline positioning only after both treatments finish", async () => {
  vi.useFakeTimers();
  const { message, element, dispose } = setupPeer();
  element.style.setProperty("position", "static", "important");
  element.innerHTML = '<span data-payload-block="inner" style="position:static">Inner</span>';
  const inner = element.querySelector("span")!;
  message(ready);
  inner.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  expect(inner.hasAttribute("data-payload-block-hover")).toBe(true);
  expect(element.hasAttribute("data-payload-block-hover")).toBe(false);
  message({ ...ready, event: "locate", ids: ["inner", "one"] });
  await vi.advanceTimersByTimeAsync(1100);
  message({ ...ready, event: "locate", ids: ["inner", "one"] });
  await vi.advanceTimersByTimeAsync(100);
  expect(inner.hasAttribute("data-payload-block-highlight")).toBe(true);
  await vi.advanceTimersByTimeAsync(1100);
  expect(inner.hasAttribute("data-payload-block-highlight")).toBe(false);
  expect(inner.style.position).toBe("relative");
  element.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  expect(inner.style.position).toBe("static");
  expect(element.style.position).toBe("relative");
  message({ ...ready, event: "locate", ids: ["one"] });
  document.body.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
  expect(element.style.position).toBe("relative");
  dispose();
  expect(element.style.position).toBe("static");
  expect(element.style.getPropertyPriority("position")).toBe("important");
  expect(
    document.querySelector("[data-payload-block-hover], [data-payload-block-highlight]"),
  ).toBeNull();
});
