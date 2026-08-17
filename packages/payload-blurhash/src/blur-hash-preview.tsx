"use client";

import { FieldDescription, FieldLabel, useField } from "@payloadcms/ui";
import { decode } from "blurhash";
import type { TextFieldClientComponent } from "payload";
import React, { useEffect, useMemo, useRef } from "react";

const MAX_CANVAS_HEIGHT = 96;
const MAX_CANVAS_WIDTH = 160;
const MAX_INTRINSIC_EDGE = 32;
const FALLBACK_ASPECT_RATIO = 3 / 2;

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

const contentStyle = {
  alignItems: "flex-start",
  display: "flex",
  flexWrap: "wrap",
  gap: "calc(var(--base) / 2)",
} as const;

const detailsStyle = {
  display: "grid",
  flex: "1 1 18rem",
  maxWidth: "36rem",
  minWidth: 0,
} as const;

const readOnlyInputStyle = {
  background: "var(--theme-elevation-100)",
  boxShadow: "none",
  color: "var(--theme-elevation-400)",
  cursor: "text",
} as const;

export const BlurHashPreview: TextFieldClientComponent = ({ path }) => {
  const { value } = useField<unknown>({ path });
  const { value: width } = useField<unknown>({ path: "width" });
  const { value: height } = useField<unknown>({ path: "height" });
  const hasStoredValue = typeof value === "string";
  const blurHash = typeof value === "string" ? value : "";
  const aspectRatio = getAspectRatio(width, height);
  const canvasDimensions = getDimensions(aspectRatio, MAX_CANVAS_WIDTH, MAX_CANVAS_HEIGHT);
  const preview = useMemo<PreviewState>(() => {
    if (!hasStoredValue) {
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
  }, [aspectRatio, blurHash, hasStoredValue]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputID = `${path}-blurhash-value`;
  const statusID = `${path}-blurhash-status`;
  const status =
    preview.status === "generated"
      ? "Generated automatically from the current image."
      : preview.status === "invalid"
        ? "The stored BlurHash could not be decoded. Its original value is preserved."
        : "No BlurHash is available for this image.";

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
    <div className="blurhash-field field-type read-only text" data-blurhash-panel="">
      <FieldLabel htmlFor={inputID} label="BlurHash" path={path} />
      <div data-blurhash-layout="" style={contentStyle}>
        <div
          data-blurhash-preview-surface=""
          style={{
            alignItems: "center",
            background: "var(--theme-elevation-100)",
            border: "1px solid var(--theme-elevation-150)",
            borderRadius: "var(--style-radius-s)",
            display: "flex",
            flex: "0 0 auto",
            height: canvasDimensions.height,
            justifyContent: "center",
            maxWidth: "100%",
            overflow: "hidden",
            width: canvasDimensions.width,
          }}
        >
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
            <span
              style={{
                color: "var(--theme-elevation-500)",
                fontSize: "0.8125rem",
                padding: "calc(var(--base) / 2)",
                textAlign: "center",
              }}
            >
              {preview.status === "invalid" ? "Preview unavailable" : "No value"}
            </span>
          )}
        </div>
        <div data-blurhash-details="" style={detailsStyle}>
          <input
            aria-describedby={statusID}
            id={inputID}
            name={path}
            readOnly
            spellCheck={false}
            style={readOnlyInputStyle}
            type="text"
            value={blurHash}
          />
          <div id={statusID}>
            <FieldDescription description={status} path={path} />
          </div>
        </div>
      </div>
    </div>
  );
};
