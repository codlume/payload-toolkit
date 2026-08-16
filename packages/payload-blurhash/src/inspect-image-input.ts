type ImageFormat = "jpeg" | "png";

export type ImageInputInspection =
  | { code: "animated_input" | "not_eligible"; status: "skipped" }
  | { code: "malformed_container" | "type_mismatch"; status: "failed" }
  | { format: ImageFormat; status: "eligible" };

const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_STANDALONE_MARKERS = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const PNG_COLOUR_DEPTHS = new Map([
  [0, new Set([1, 2, 4, 8, 16])],
  [2, new Set([8, 16])],
  [3, new Set([1, 2, 4, 8])],
  [4, new Set([8, 16])],
  [6, new Set([8, 16])],
]);

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

const hasSignature = (input: Buffer, signature: Buffer) =>
  input.length >= signature.length && input.subarray(0, signature.length).equals(signature);

const isValidJpeg = (input: Buffer) => {
  let foundFrame = false;
  let foundScan = false;
  let inScan = false;
  let offset = 2;

  while (offset < input.length) {
    if (inScan) {
      while (offset < input.length && input[offset] !== 0xff) {
        offset += 1;
      }

      if (offset >= input.length) {
        return false;
      }
    } else if (input[offset] !== 0xff) {
      return false;
    }

    while (offset < input.length && input[offset] === 0xff) {
      offset += 1;
    }

    if (offset >= input.length) {
      return false;
    }

    const marker = input[offset];
    offset += 1;

    if (marker === undefined) {
      return false;
    }

    if (inScan && marker === 0x00) {
      continue;
    }

    if (marker === 0xd9) {
      return foundFrame && foundScan && offset === input.length;
    }

    if (marker === 0xd8 || marker === 0x00) {
      return false;
    }

    if (JPEG_STANDALONE_MARKERS.has(marker)) {
      if (!inScan && marker !== 0x01) {
        return false;
      }

      continue;
    }

    inScan = false;

    if (offset + 2 > input.length) {
      return false;
    }

    const segmentLength = input.readUInt16BE(offset);
    const segmentEnd = offset + segmentLength;

    if (segmentLength < 2 || segmentEnd > input.length) {
      return false;
    }

    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      const componentCount = input[offset + 7];

      if (
        segmentLength < 11 ||
        componentCount === undefined ||
        segmentLength !== 8 + componentCount * 3 ||
        input.readUInt16BE(offset + 3) === 0 ||
        input.readUInt16BE(offset + 5) === 0
      ) {
        return false;
      }

      foundFrame = true;
    }

    if (marker === 0xda) {
      if (!foundFrame || segmentLength < 8) {
        return false;
      }

      foundScan = true;
      inScan = true;
    }

    offset = segmentEnd;
  }

  return false;
};

const updateCrc = (crc: number, data: Buffer) => {
  let next = crc;

  for (const byte of data) {
    next = (crcTable[(next ^ byte) & 0xff] ?? 0) ^ (next >>> 8);
  }

  return next;
};

const hasValidPngCrc = (type: Buffer, data: Buffer, expected: number) => {
  let crc = updateCrc(0xffffffff, type);
  crc = updateCrc(crc, data);
  return (crc ^ 0xffffffff) >>> 0 === expected;
};

const inspectPng = (input: Buffer): ImageInputInspection => {
  let animated = false;
  let foundImageData = false;
  let foundHeader = false;
  let offset = PNG_SIGNATURE.length;

  while (offset < input.length) {
    if (input.length - offset < 12) {
      return { code: "malformed_container", status: "failed" };
    }

    const length = input.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;

    if (length > input.length - offset - 12 || chunkEnd > input.length) {
      return { code: "malformed_container", status: "failed" };
    }

    const typeBytes = input.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    const data = input.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = input.readUInt32BE(offset + 8 + length);

    if (
      !/^[A-Za-z]{4}$/.test(type) ||
      type[2] !== type[2]?.toUpperCase() ||
      !hasValidPngCrc(typeBytes, data, expectedCrc)
    ) {
      return { code: "malformed_container", status: "failed" };
    }

    if (!foundHeader) {
      const colourType = data[9];
      const supportedDepths =
        colourType === undefined ? undefined : PNG_COLOUR_DEPTHS.get(colourType);

      if (
        type !== "IHDR" ||
        length !== 13 ||
        data.readUInt32BE(0) === 0 ||
        data.readUInt32BE(4) === 0 ||
        !supportedDepths?.has(data[8] ?? -1) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        (data[12] !== 0 && data[12] !== 1)
      ) {
        return { code: "malformed_container", status: "failed" };
      }

      foundHeader = true;
      offset = chunkEnd;
      continue;
    }

    if (
      type === "IHDR" ||
      (type[0] === type[0]?.toUpperCase() && !["IDAT", "IEND", "PLTE"].includes(type))
    ) {
      return { code: "malformed_container", status: "failed" };
    }

    if (type === "acTL") {
      if (length !== 8 || data.readUInt32BE(0) === 0) {
        return { code: "malformed_container", status: "failed" };
      }

      animated = true;
    } else if (type === "IDAT") {
      foundImageData = true;
    } else if (type === "IEND") {
      if (length !== 0 || !foundImageData || chunkEnd !== input.length) {
        return { code: "malformed_container", status: "failed" };
      }

      return animated
        ? { code: "animated_input", status: "skipped" }
        : { format: "png", status: "eligible" };
    }

    offset = chunkEnd;
  }

  return { code: "malformed_container", status: "failed" };
};

export const inspectImageInput = (input: Buffer, mimeType: unknown): ImageInputInspection => {
  const expectedFormat =
    mimeType === "image/jpeg" ? "jpeg" : mimeType === "image/png" ? "png" : undefined;

  if (!expectedFormat) {
    return { code: "not_eligible", status: "skipped" };
  }

  const signatureFormat = hasSignature(input, JPEG_SIGNATURE)
    ? "jpeg"
    : hasSignature(input, PNG_SIGNATURE)
      ? "png"
      : undefined;

  if (signatureFormat && signatureFormat !== expectedFormat) {
    return { code: "type_mismatch", status: "failed" };
  }

  if (!signatureFormat) {
    return { code: "malformed_container", status: "failed" };
  }

  if (signatureFormat === "jpeg") {
    return isValidJpeg(input)
      ? { format: "jpeg", status: "eligible" }
      : { code: "malformed_container", status: "failed" };
  }

  return inspectPng(input);
};
