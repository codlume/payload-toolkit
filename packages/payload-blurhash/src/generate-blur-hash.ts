import type { FieldHook } from "payload";

import { encodeBlurHash } from "./encode-blur-hash.ts";
import { inspectImageInput } from "./inspect-image-input.ts";

const MAX_PREVIEW_EDGE = 32;

type GenerateBlurHashOptions = {
  alphaBackground: { b: number; g: number; r: number };
};

export const generateBlurHash = async (
  { data, req }: Parameters<FieldHook>[0],
  { alphaBackground }: GenerateBlurHashOptions,
) => {
  if (!req.file?.data) {
    return null;
  }

  const inspection = inspectImageInput(req.file.data, data?.mimeType);

  if (inspection.status !== "eligible") {
    return null;
  }

  const sharp = req.payload.config.sharp;
  if (!sharp) {
    return null;
  }

  const metadata = await sharp(req.file.data, { animated: true, failOn: "warning" }).metadata();

  if (
    metadata.format !== inspection.format ||
    (inspection.format === "png" && metadata.pages !== undefined && metadata.pages !== 1)
  ) {
    return null;
  }

  const { data: pixels, info } = await sharp(req.file.data, { failOn: "warning" })
    .rotate()
    .toColorspace("srgb")
    .flatten({ background: alphaBackground })
    .resize({
      fit: "inside",
      height: MAX_PREVIEW_EDGE,
      width: MAX_PREVIEW_EDGE,
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw({ depth: "uchar" })
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 4 || info.width < 1 || info.height < 1) {
    return null;
  }

  return encodeBlurHash(new Uint8ClampedArray(pixels), info.width, info.height);
};
