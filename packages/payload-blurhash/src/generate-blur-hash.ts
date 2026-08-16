import type { FieldHook } from "payload";

import { encodeBlurHash } from "./encode-blur-hash.ts";

const MAX_PREVIEW_EDGE = 32;

export const generateBlurHash: FieldHook = async ({ data, req }) => {
  if (data?.mimeType !== "image/jpeg" || !req.file?.data) {
    return null;
  }

  const sharp = req.payload.config.sharp;
  if (!sharp) {
    return null;
  }

  const { data: pixels, info } = await sharp(req.file.data)
    .resize({
      fit: "inside",
      height: MAX_PREVIEW_EDGE,
      width: MAX_PREVIEW_EDGE,
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return encodeBlurHash(new Uint8ClampedArray(pixels), info.width, info.height);
};
