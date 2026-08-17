// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { BlurHashPreview } from "@codlume/payload-blurhash/client";

const GENERATED_BLUR_HASH = "L~Lqe9|ldL|l~h|c_X|cfH|T|c|T";
const formValues = vi.hoisted((): { current: Record<string, unknown> } => ({
  current: {},
}));

vi.mock("@payloadcms/ui", () => ({
  FieldDescription: ({ description }: { description: string }) => (
    <div className="field-description">{description}</div>
  ),
  FieldLabel: ({ htmlFor, label }: { htmlFor: string; label: string }) => (
    <label className="field-label" htmlFor={htmlFor}>
      {label}
    </label>
  ),
  useField: ({ path }: { path: string }) => ({ value: formValues.current[path] }),
}));

const renderPreview = (value: null | string, width?: number, height?: number) => {
  formValues.current = { blurHash: value, height, width };

  return render(<BlurHashPreview field={{ name: "blurHash" }} path="blurHash" />);
};

const putImageData = vi.fn();
const originalGetContext = Object.getOwnPropertyDescriptor(
  HTMLCanvasElement.prototype,
  "getContext",
);

beforeEach(() => {
  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: vi.fn(() => ({
      createImageData: (width: number, height: number) => ({
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData,
    })),
  });
});

afterEach(() => {
  cleanup();
  putImageData.mockClear();
  vi.restoreAllMocks();

  if (originalGetContext) {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalGetContext);
  }
});

test("generated BlurHash is presented as one static accessible preview", () => {
  const { container } = renderPreview(GENERATED_BLUR_HASH);
  const input = screen.getByLabelText("BlurHash");
  const canvas = container.querySelector("canvas");

  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected the read-only value control to be an input");
  }

  expect({
    canvas: canvas && {
      ariaHidden: canvas.getAttribute("aria-hidden"),
      height: canvas.height,
      styleAspectRatio: canvas.style.aspectRatio,
      styleHeight: canvas.style.height,
      styleWidth: canvas.style.width,
      tabIndex: canvas.tabIndex,
      width: canvas.width,
    },
    describedBy: input.getAttribute("aria-describedby"),
    disabled: input.disabled,
    drawCount: putImageData.mock.calls.length,
    fieldLabel: screen.getByText("BlurHash").textContent,
    liveRegions: container.querySelectorAll("[aria-live]").length,
    readOnly: input.readOnly,
    status: screen.getByText("Generated automatically from the current image.").textContent,
    value: input.value,
  }).toEqual({
    canvas: {
      ariaHidden: "true",
      height: 21,
      styleAspectRatio: "1.5",
      styleHeight: "auto",
      styleWidth: "144px",
      tabIndex: -1,
      width: 32,
    },
    describedBy: "blurHash-blurhash-status",
    disabled: false,
    drawCount: 1,
    fieldLabel: "BlurHash",
    liveRegions: 0,
    readOnly: true,
    status: "Generated automatically from the current image.",
    value: GENERATED_BLUR_HASH,
  });
});

test("generated BlurHash follows Payload's compact field hierarchy", () => {
  const { container } = renderPreview(GENERATED_BLUR_HASH);
  const panel = container.querySelector("[data-blurhash-panel]");
  const canvas = container.querySelector("canvas");
  const details = container.querySelector("[data-blurhash-details]");
  const input = screen.queryByLabelText("BlurHash");
  const layout = container.querySelector("[data-blurhash-layout]");
  const generatedDescription = screen.queryByText(
    "Generated automatically from the current image.",
  );

  if (!(panel instanceof HTMLElement)) {
    throw new TypeError("Expected the BlurHash field container to be an element");
  }

  expect({
    cardChrome: {
      background: panel.style.background,
      border: panel.style.border,
      borderRadius: panel.style.borderRadius,
      padding: panel.style.padding,
    },
    canvasWidth: canvas?.style.width,
    descriptionInDetails: details?.contains(generatedDescription ?? null),
    duplicateLabel: screen.queryByText("Read-only value")?.textContent,
    fieldClasses: {
      blurHash: panel.classList.contains("blurhash-field"),
      payloadField: panel.classList.contains("field-type"),
      textField: panel.classList.contains("text"),
    },
    generatedDescription: generatedDescription?.textContent,
    input: input && {
      background: input instanceof HTMLInputElement ? input.style.background : undefined,
      boxShadow: input instanceof HTMLInputElement ? input.style.boxShadow : undefined,
      color: input instanceof HTMLInputElement ? input.style.color : undefined,
      cursor: input instanceof HTMLInputElement ? input.style.cursor : undefined,
      disabled: input instanceof HTMLInputElement && input.disabled,
      readOnly: input instanceof HTMLInputElement && input.readOnly,
      value: input instanceof HTMLInputElement ? input.value : undefined,
    },
    layoutAlignment: layout instanceof HTMLElement ? layout.style.alignItems : undefined,
    paragraphCount: panel?.querySelectorAll("p").length,
  }).toEqual({
    cardChrome: {
      background: "",
      border: "",
      borderRadius: "",
      padding: "",
    },
    canvasWidth: "144px",
    descriptionInDetails: true,
    duplicateLabel: undefined,
    fieldClasses: {
      blurHash: true,
      payloadField: true,
      textField: true,
    },
    generatedDescription: "Generated automatically from the current image.",
    input: {
      background: "var(--theme-elevation-100)",
      boxShadow: "none",
      color: "var(--theme-elevation-400)",
      cursor: "text",
      disabled: false,
      readOnly: true,
      value: GENERATED_BLUR_HASH,
    },
    layoutAlignment: "flex-start",
    paragraphCount: 0,
  });
});

test("missing BlurHash is presented without a canvas", () => {
  const { container } = renderPreview(null, 640, 480);
  const input = screen.getByLabelText("BlurHash");

  if (!(input instanceof HTMLInputElement)) {
    throw new TypeError("Expected the read-only value control to be an input");
  }

  expect({
    canvasCount: container.querySelectorAll("canvas").length,
    drawCount: putImageData.mock.calls.length,
    state: screen.getByText("No value").textContent,
    status: screen.getByText("No BlurHash is available for this image.").textContent,
    value: input.value,
  }).toEqual({
    canvasCount: 0,
    drawCount: 0,
    state: "No value",
    status: "No BlurHash is available for this image.",
    value: "",
  });
});

test.each(["", "not-a-blurhash"])(
  "invalid BlurHash %j remains selectable without breaking the field",
  (invalidValue) => {
    const { container } = renderPreview(invalidValue, 640, 480);
    const input = screen.getByLabelText("BlurHash");

    if (!(input instanceof HTMLInputElement)) {
      throw new TypeError("Expected the read-only value control to be an input");
    }

    expect({
      canvasCount: container.querySelectorAll("canvas").length,
      disabled: input.disabled,
      drawCount: putImageData.mock.calls.length,
      readOnly: input.readOnly,
      state: screen.getByText("Preview unavailable").textContent,
      status: screen.getByText(
        "The stored BlurHash could not be decoded. Its original value is preserved.",
      ).textContent,
      value: input.value,
    }).toEqual({
      canvasCount: 0,
      disabled: false,
      drawCount: 0,
      readOnly: true,
      state: "Preview unavailable",
      status: "The stored BlurHash could not be decoded. Its original value is preserved.",
      value: invalidValue,
    });
  },
);

test("preview work is memoized by BlurHash and aspect ratio", () => {
  const { container, rerender } = renderPreview(GENERATED_BLUR_HASH, 150, 100);

  rerender(<BlurHashPreview field={{ name: "blurHash" }} path="blurHash" />);
  formValues.current = { blurHash: GENERATED_BLUR_HASH, height: 100, width: 151 };
  rerender(<BlurHashPreview field={{ name: "blurHash" }} path="blurHash" />);

  const canvas = container.querySelector("canvas");

  expect({
    drawCount: putImageData.mock.calls.length,
    height: canvas?.height,
    longestIntrinsicEdge: canvas ? Math.max(canvas.width, canvas.height) : undefined,
    styleAspectRatio: canvas?.style.aspectRatio,
    styleHeight: canvas?.style.height,
    styleWidth: canvas?.style.width,
  }).toEqual({
    drawCount: 2,
    height: 21,
    longestIntrinsicEdge: 32,
    styleAspectRatio: "1.51",
    styleHeight: "auto",
    styleWidth: "144.96px",
  });
});
