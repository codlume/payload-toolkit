import sharp from "sharp";

export const createJpegFixture = (background: { b: number; g: number; r: number }) =>
  sharp({
    create: {
      background,
      channels: 3,
      height: 12,
      width: 16,
    },
  })
    .jpeg()
    .toBuffer();
