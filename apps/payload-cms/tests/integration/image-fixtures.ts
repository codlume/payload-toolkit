import { readFile } from "node:fs/promises";

import sharp from "sharp";

const fixtureDirectory = new URL("../fixtures/images/", import.meta.url);

export const readImageFixture = (name: string) => readFile(new URL(name, fixtureDirectory));

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
