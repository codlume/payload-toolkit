"use client";

import { useField } from "@payloadcms/ui";
import { decode } from "blurhash";
import type { TextFieldClientComponent } from "payload";
import React, { useEffect, useMemo, useRef } from "react";

const MAX_CANVAS_HEIGHT = 180;
const MAX_CANVAS_WIDTH = 288;
const MAX_INTRINSIC_EDGE = 32;
const FALLBACK_ASPECT_RATIO = 3 / 2;
const NARROW_LAYOUT_STYLE = `
  @media (max-width: 48rem) {
    [data-blurhash-layout] {
      grid-template-columns: minmax(0, 1fr) !important;
    }
  }
`;

type PreviewState =
  | { height: number; pixels: Uint8ClampedArray; status: "generated"; width: number }
  | { status: "invalid" | "missing" };

const getAspectRatio = (width: unknown, height: unknown) =>
  typeof width === "number" &&
  Number.isFinite(width) &&
  width > 0 &&
  typeof height === "number" &&
  Number.isFinite(height) &&
  height > 0
    ? width / height
    : FALLBACK_ASPECT_RATIO;

const getDimensions = (aspectRatio: number, maxWidth: number, maxHeight: number) => {
  const widthFromHeight = maxHeight * aspectRatio;

  if (widthFromHeight <= maxWidth) {
    return { height: maxHeight, width: widthFromHeight };
  }

  return { height: maxWidth / aspectRatio, width: maxWidth };
};

const getIntrinsicDimensions = (aspectRatio: number) => {
  const dimensions = getDimensions(aspectRatio, MAX_INTRINSIC_EDGE, MAX_INTRINSIC_EDGE);

  return {
    height: Math.max(1, Math.round(dimensions.height)),
    width: Math.max(1, Math.round(dimensions.width)),
  };
};

const panelStyle = {
  background: "var(--theme-elevation-50)",
  border: "1px solid var(--theme-elevation-150)",
  borderRadius: "var(--style-radius-m)",
  padding: "var(--base)",
  width: "100%",
} as const;

const contentStyle = {
  display: "grid",
  gap: "var(--base)",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(18rem, 100%), 1fr))",
} as const;

const previewSurfaceStyle = {
  alignItems: "center",
  background: "var(--theme-elevation-100)",
  display: "flex",
  justifyContent: "center",
  minHeight: 180,
  minWidth: 0,
} as const;

const detailsStyle = {
  display: "grid",
  gap: "calc(var(--base) / 2)",
  minWidth: 0,
} as const;

export const BlurHashPreview: TextFieldClientComponent = ({ path }) => {
  const { value } = useField<unknown>({ path });
  const { value: width } = useField<unknown>({ path: "width" });
  const { value: height } = useField<unknown>({ path: "height" });
  const blurHash = typeof value === "string" ? value : "";
  const aspectRatio = getAspectRatio(width, height);
  const canvasDimensions = getDimensions(aspectRatio, MAX_CANVAS_WIDTH, MAX_CANVAS_HEIGHT);
  const preview = useMemo<PreviewState>(() => {
    if (blurHash.length === 0) {
      return { status: "missing" };
    }

    const intrinsicDimensions = getIntrinsicDimensions(aspectRatio);

    try {
      return {
        ...intrinsicDimensions,
        pixels: decode(blurHash, intrinsicDimensions.width, intrinsicDimensions.height),
        status: "generated",
      };
    } catch {
      return { status: "invalid" };
    }
  }, [aspectRatio, blurHash]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const helpID = `${path}-blurhash-help`;
  const inputID = `${path}-blurhash-value`;
  const statusID = `${path}-blurhash-status`;

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");

    if (!context || preview.status !== "generated") {
      return;
    }

    const imageData = context.createImageData(preview.width, preview.height);
    imageData.data.set(preview.pixels);
    context.putImageData(imageData, 0, 0);
  }, [preview]);

  return (
    <section aria-labelledby={`${path}-blurhash-label`} data-blurhash-panel="" style={panelStyle}>
      <style>{NARROW_LAYOUT_STYLE}</style>
      <h3 id={`${path}-blurhash-label`}>BlurHash</h3>
      <div data-blurhash-layout="" style={contentStyle}>
        <div data-blurhash-preview-surface="" style={previewSurfaceStyle}>
          {preview.status === "generated" ? (
            <canvas
              aria-hidden="true"
              data-blurhash-preview=""
              height={preview.height}
              ref={canvasRef}
              style={{
                aspectRatio,
                display: "block",
                height: "auto",
                maxHeight: MAX_CANVAS_HEIGHT,
                maxWidth: "100%",
                width: canvasDimensions.width,
              }}
              tabIndex={-1}
              width={preview.width}
            />
          ) : (
            <span>{preview.status === "invalid" ? "Preview unavailable" : "No value"}</span>
          )}
        </div>
        <div data-blurhash-details="" style={detailsStyle}>
          <label htmlFor={inputID}>Read-only value</label>
          <input
            aria-describedby={`${helpID} ${statusID}`}
            id={inputID}
            name={path}
            readOnly
            type="text"
            value={blurHash}
          />
          <p id={statusID}>
            {preview.status === "generated"
              ? "BlurHash generated from the current image."
              : preview.status === "invalid"
                ? "The stored BlurHash could not be decoded. Its original value is preserved."
                : "No BlurHash is available for this image."}
          </p>
          <p id={helpID}>
            A compact placeholder generated from the current image. The value is managed
            automatically.
          </p>
        </div>
      </div>
    </section>
  );
};
