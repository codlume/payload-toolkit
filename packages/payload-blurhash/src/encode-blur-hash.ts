import { encode } from "blurhash";

const COMPONENTS_X = 4;
const COMPONENTS_Y = 3;

export const encodeBlurHash = (pixels: Uint8ClampedArray, width: number, height: number): string =>
  encode(pixels, width, height, COMPONENTS_X, COMPONENTS_Y);
