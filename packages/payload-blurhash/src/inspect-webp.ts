import type { ImageInputInspection } from "./inspect-image-input.ts";

const WEBP_HEADER_SIZE = 12;
const VP8X_ANIMATION_FLAG = 0x02;
const VP8X_RESERVED_FLAGS = 0xc1;

export const inspectWebp = (input: Buffer): ImageInputInspection => {
  if (input.length < WEBP_HEADER_SIZE || input.readUInt32LE(4) !== input.length - 8) {
    return { code: "malformed_container", status: "failed" };
  }

  let animated = false;
  let imageChunks = 0;
  let offset = WEBP_HEADER_SIZE;
  let sawExtendedHeader = false;

  while (offset < input.length) {
    if (input.length - offset < 8) {
      return { code: "malformed_container", status: "failed" };
    }

    const type = input.subarray(offset, offset + 4).toString("ascii");
    const length = input.readUInt32LE(offset + 4);
    const paddedLength = length + (length % 2);
    const chunkEnd = offset + 8 + paddedLength;

    if (chunkEnd > input.length) {
      return { code: "malformed_container", status: "failed" };
    }

    if (length % 2 === 1 && input[chunkEnd - 1] !== 0) {
      return { code: "malformed_container", status: "failed" };
    }

    const data = input.subarray(offset + 8, offset + 8 + length);

    if (offset === WEBP_HEADER_SIZE && !["VP8 ", "VP8L", "VP8X"].includes(type)) {
      return { code: "malformed_container", status: "failed" };
    }

    if (type === "VP8X") {
      if (
        sawExtendedHeader ||
        offset !== WEBP_HEADER_SIZE ||
        length !== 10 ||
        ((data[0] ?? 0) & VP8X_RESERVED_FLAGS) !== 0 ||
        data.subarray(1, 4).some((byte) => byte !== 0)
      ) {
        return { code: "malformed_container", status: "failed" };
      }

      sawExtendedHeader = true;
      animated ||= ((data[0] ?? 0) & VP8X_ANIMATION_FLAG) !== 0;
    } else if (type === "VP8 " || type === "VP8L") {
      imageChunks += 1;
    } else if (type === "ANIM" || type === "ANMF") {
      animated = true;
    }

    offset = chunkEnd;
  }

  if (animated) {
    return { code: "animated_input", status: "skipped" };
  }

  return imageChunks === 1
    ? { format: "webp", status: "eligible" }
    : { code: "malformed_container", status: "failed" };
};
