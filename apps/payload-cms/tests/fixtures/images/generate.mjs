import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

import sharp from "sharp";

const fixtureDirectory = fileURLToPath(new URL("./", import.meta.url));
const width = 40;
const height = 24;

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;

  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }

  return crc >>> 0;
});

const crc32 = (data) => {
  let crc = 0xffffffff;

  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type, data = Buffer.alloc(0)) => {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));

  return Buffer.concat([length, typeBytes, data, checksum]);
};

const pngScanlines = (r, g, b, a = 255) => {
  const rows = [];

  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);

    for (let x = 0; x < width; x += 1) {
      const offset = 1 + x * 4;
      row[offset] = r;
      row[offset + 1] = g;
      row[offset + 2] = b;
      row[offset + 3] = a;
    }

    rows.push(row);
  }

  return Buffer.concat(rows);
};

const createApng = (frames) => {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const animationControl = Buffer.alloc(8);
  animationControl.writeUInt32BE(frames.length, 0);
  const chunks = [signature, pngChunk("IHDR", ihdr), pngChunk("acTL", animationControl)];
  let sequence = 0;

  frames.forEach((frame, index) => {
    const frameControl = Buffer.alloc(26);
    frameControl.writeUInt32BE(sequence, 0);
    frameControl.writeUInt32BE(width, 4);
    frameControl.writeUInt32BE(height, 8);
    frameControl.writeUInt16BE(1, 20);
    frameControl.writeUInt16BE(10, 22);
    chunks.push(pngChunk("fcTL", frameControl));
    sequence += 1;

    const compressed = deflateSync(pngScanlines(frame.r, frame.g, frame.b));

    if (index === 0) {
      chunks.push(pngChunk("IDAT", compressed));
      return;
    }

    const frameData = Buffer.alloc(4 + compressed.length);
    frameData.writeUInt32BE(sequence, 0);
    compressed.copy(frameData, 4);
    chunks.push(pngChunk("fdAT", frameData));
    sequence += 1;
  });

  chunks.push(pngChunk("IEND"));
  return Buffer.concat(chunks);
};

const createRgbPixels = () => {
  const pixels = Buffer.alloc(width * height * 3);
  const colours = [
    [235, 40, 45],
    [35, 205, 80],
    [40, 80, 230],
    [235, 205, 35],
  ];

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
      const colour = colours[quadrant];
      const offset = (y * width + x) * 3;
      pixels[offset] = Math.min(255, colour[0] + (x % 5));
      pixels[offset + 1] = Math.min(255, colour[1] + (y % 5));
      pixels[offset + 2] = colour[2];
    }
  }

  return pixels;
};

const createAlphaPixels = (hiddenColour) => {
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const transparent = x < width / 3;
      const alpha = transparent ? 0 : x < (width * 2) / 3 ? 128 : 255;
      const colour = transparent ? hiddenColour : [30, 120 + (y % 8), 220];
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = alpha;
    }
  }

  return pixels;
};

const rgbPixels = createRgbPixels();
const rgbInput = () => sharp(rgbPixels, { raw: { channels: 3, height, width } });
const jpegOptions = { chromaSubsampling: "4:4:4", quality: 90 };
const fixtures = [];

const setExifOrientation = (jpeg, orientation) => {
  const bytes = Buffer.from(jpeg);
  const orientationEntry = Buffer.from("120103000100000001000000", "hex");
  const entryOffset = bytes.indexOf(orientationEntry);

  if (entryOffset === -1) {
    throw new Error("Generated JPEG does not contain an EXIF orientation entry");
  }

  bytes.writeUInt16LE(orientation, entryOffset + 8);
  return bytes;
};

const addFixture = async (name, bytes, facts, expected) => {
  await writeFile(new URL(name, import.meta.url), bytes);
  const metadata = await sharp(bytes, { animated: true })
    .metadata()
    .catch(() => undefined);
  fixtures.push({
    bytes: bytes.length,
    dimensions:
      metadata?.width && metadata.height
        ? { height: metadata.height, width: metadata.width }
        : null,
    expected,
    facts,
    mime: name.endsWith(".png") ? "image/png" : "image/jpeg",
    name,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
};

await mkdir(fixtureDirectory, { recursive: true });

const baselineJpeg = await rgbInput()
  .jpeg({ ...jpegOptions, progressive: false })
  .toBuffer();
await addFixture(
  "jpeg-baseline.jpg",
  baselineJpeg,
  ["baseline DCT", "RGB", "no EXIF orientation"],
  "eligible",
);
await addFixture(
  "jpeg-progressive.jpg",
  await rgbInput()
    .jpeg({ ...jpegOptions, progressive: true })
    .toBuffer(),
  ["progressive DCT", "RGB"],
  "eligible",
);

const grayscalePixels = Buffer.from(
  Array.from({ length: width * height }, (_, index) => (index * 17) % 256),
);
await addFixture(
  "jpeg-grayscale.jpg",
  await sharp(grayscalePixels, { raw: { channels: 1, height, width } })
    .jpeg(jpegOptions)
    .toBuffer(),
  ["baseline DCT", "grayscale"],
  "eligible",
);
await addFixture(
  "jpeg-cmyk.jpg",
  await rgbInput().toColourspace("cmyk").jpeg(jpegOptions).toBuffer(),
  ["baseline DCT", "CMYK"],
  "eligible",
);
await addFixture(
  "jpeg-icc-p3.jpg",
  await rgbInput().withIccProfile("p3").jpeg(jpegOptions).toBuffer(),
  ["baseline DCT", "embedded Display P3 ICC profile"],
  "eligible",
);

await Promise.all(
  Array.from({ length: 7 }, (_, index) => index + 2).map(async (orientation) => {
    const tagged = await rgbInput()
      .withExif({ IFD0: { Orientation: "1" } })
      .jpeg(jpegOptions)
      .toBuffer();
    const oriented = setExifOrientation(tagged, orientation);
    const reference = await sharp(oriented).rotate().jpeg(jpegOptions).toBuffer();
    await addFixture(
      `jpeg-orientation-${orientation}.jpg`,
      oriented,
      [`baseline DCT`, `EXIF orientation ${orientation}`],
      "eligible",
    );
    await addFixture(
      `jpeg-orientation-${orientation}-reference.jpg`,
      reference,
      ["baseline DCT", `pixels normalized for EXIF orientation ${orientation}`],
      "eligible",
    );
  }),
);

await addFixture(
  "jpeg-truncated.jpg",
  baselineJpeg.subarray(0, Math.floor(baselineJpeg.length / 2)),
  ["JPEG signature", "truncated entropy data", "missing EOI"],
  "malformed_container",
);
await addFixture(
  "jpeg-malformed.jpg",
  Buffer.concat([baselineJpeg, Buffer.from("unexpected trailing bytes")]),
  ["decodable JPEG", "bytes after EOI"],
  "malformed_container",
);

const opaquePng = await rgbInput().png().toBuffer();
await addFixture("png-opaque.png", opaquePng, ["PNG", "RGB", "opaque"], "eligible");
const alphaRed = createAlphaPixels([255, 0, 0]);
const alphaBlue = createAlphaPixels([0, 0, 255]);
const alphaRedInput = () => sharp(alphaRed, { raw: { channels: 4, height, width } });
await addFixture(
  "png-alpha-hidden-red.png",
  await alphaRedInput().png().toBuffer(),
  ["PNG", "RGBA", "transparent pixels retain hidden red RGB"],
  "eligible",
);
await addFixture(
  "png-alpha-hidden-blue.png",
  await sharp(alphaBlue, { raw: { channels: 4, height, width } })
    .png()
    .toBuffer(),
  ["PNG", "RGBA", "transparent pixels retain hidden blue RGB"],
  "eligible",
);
await addFixture(
  "png-alpha-white-reference.png",
  await alphaRedInput()
    .flatten({ background: { b: 255, g: 255, r: 255 } })
    .png()
    .toBuffer(),
  ["PNG", "RGB", "alpha fixture composited against white"],
  "eligible",
);
await addFixture(
  "png-alpha-black-reference.png",
  await alphaRedInput()
    .flatten({ background: { b: 0, g: 0, r: 0 } })
    .png()
    .toBuffer(),
  ["PNG", "RGB", "alpha fixture composited against black"],
  "eligible",
);

await addFixture(
  "png-apng-two-frame.png",
  createApng([
    { b: 40, g: 50, r: 220 },
    { b: 220, g: 180, r: 30 },
  ]),
  ["PNG", "APNG acTL", "two frames"],
  "animated_input",
);
await addFixture(
  "png-actl-single-frame.png",
  createApng([{ b: 40, g: 50, r: 220 }]),
  ["PNG", "APNG acTL", "one frame"],
  "animated_input",
);
await addFixture(
  "png-truncated.png",
  opaquePng.subarray(0, opaquePng.length - 8),
  ["PNG signature", "missing IEND"],
  "malformed_container",
);
const badCrcPng = Buffer.from(opaquePng);
badCrcPng[badCrcPng.length - 5] ^= 0xff;
await addFixture(
  "png-bad-crc.png",
  badCrcPng,
  ["PNG signature", "invalid IEND CRC"],
  "malformed_container",
);

const manifest = {
  corpusLicense: "MIT",
  generatedBy: {
    generator: "tests/fixtures/images/generate.mjs@1",
    libvips: sharp.versions.vips,
    node: process.version,
    sharp: sharp.versions.sharp,
  },
  provenance:
    "Procedurally generated for Payload Toolkit from original pixel patterns; no third-party image source was used.",
  fixtures: fixtures.toSorted((left, right) => left.name.localeCompare(right.name)),
};

await writeFile(
  new URL("manifest.json", import.meta.url),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
