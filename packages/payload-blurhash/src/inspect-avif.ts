import type { ImageInputInspection } from "./inspect-image-input.ts";

type IsoBox = {
  dataEnd: number;
  dataStart: number;
  type: string;
};

type ImageItem = {
  hidden: boolean;
  id: number;
  type: string;
};

const IMAGE_ITEM_TYPES = new Set(["av01", "grid"]);

const readBox = (input: Buffer, offset: number, end: number) => {
  if (end - offset < 8) {
    return undefined;
  }

  let size = input.readUInt32BE(offset);
  let headerSize = 8;

  if (size === 1) {
    if (end - offset < 16) {
      return undefined;
    }

    const largeSize = input.readBigUInt64BE(offset + 8);

    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) {
      return undefined;
    }

    size = Number(largeSize);
    headerSize = 16;
  } else if (size === 0) {
    size = end - offset;
  }

  const boxEnd = offset + size;

  if (size < headerSize || boxEnd > end) {
    return undefined;
  }

  return {
    box: {
      dataEnd: boxEnd,
      dataStart: offset + headerSize,
      type: input.subarray(offset + 4, offset + 8).toString("ascii"),
    } satisfies IsoBox,
    nextOffset: boxEnd,
  };
};

const readBoxes = (input: Buffer, start: number, end: number) => {
  const boxes: IsoBox[] = [];
  let offset = start;

  while (offset < end) {
    const parsed = readBox(input, offset, end);

    if (!parsed) {
      return undefined;
    }

    boxes.push(parsed.box);
    offset = parsed.nextOffset;
  }

  return boxes;
};

const readFullBox = (input: Buffer, box: IsoBox) => {
  if (box.dataEnd - box.dataStart < 4) {
    return undefined;
  }

  return {
    dataStart: box.dataStart + 4,
    flags: input.readUIntBE(box.dataStart + 1, 3),
    version: input[box.dataStart] ?? -1,
  };
};

const readFileTypeBrands = (input: Buffer, box: IsoBox) => {
  if (box.dataEnd - box.dataStart < 8 || (box.dataEnd - box.dataStart - 8) % 4 !== 0) {
    return undefined;
  }

  const brands = new Set([input.subarray(box.dataStart, box.dataStart + 4).toString("ascii")]);

  for (let offset = box.dataStart + 8; offset < box.dataEnd; offset += 4) {
    brands.add(input.subarray(offset, offset + 4).toString("ascii"));
  }

  return brands;
};

export const hasAvifBrand = (input: Buffer) => {
  const first = readBox(input, 0, input.length)?.box;
  const brands = first?.type === "ftyp" ? readFileTypeBrands(input, first) : undefined;

  return brands?.has("avif") === true || brands?.has("avis") === true;
};

const readPrimaryItem = (input: Buffer, box: IsoBox) => {
  const fullBox = readFullBox(input, box);

  if (!fullBox) {
    return undefined;
  }

  if (fullBox.version === 0 && box.dataEnd - fullBox.dataStart === 2) {
    return input.readUInt16BE(fullBox.dataStart);
  }

  if (fullBox.version === 1 && box.dataEnd - fullBox.dataStart === 4) {
    return input.readUInt32BE(fullBox.dataStart);
  }

  return undefined;
};

const readImageItem = (input: Buffer, box: IsoBox) => {
  const fullBox = readFullBox(input, box);

  if (!fullBox || (fullBox.version !== 2 && fullBox.version !== 3)) {
    return undefined;
  }

  const idSize = fullBox.version === 2 ? 2 : 4;
  const typeOffset = fullBox.dataStart + idSize + 2;

  if (typeOffset + 4 > box.dataEnd) {
    return undefined;
  }

  return {
    hidden: (fullBox.flags & 1) !== 0,
    id:
      idSize === 2 ? input.readUInt16BE(fullBox.dataStart) : input.readUInt32BE(fullBox.dataStart),
    type: input.subarray(typeOffset, typeOffset + 4).toString("ascii"),
  } satisfies ImageItem;
};

const readImageItems = (input: Buffer, box: IsoBox) => {
  const fullBox = readFullBox(input, box);

  if (!fullBox || (fullBox.version !== 0 && fullBox.version !== 1)) {
    return undefined;
  }

  const countSize = fullBox.version === 0 ? 2 : 4;

  if (fullBox.dataStart + countSize > box.dataEnd) {
    return undefined;
  }

  const count =
    countSize === 2 ? input.readUInt16BE(fullBox.dataStart) : input.readUInt32BE(fullBox.dataStart);
  const itemBoxes = readBoxes(input, fullBox.dataStart + countSize, box.dataEnd);

  if (!itemBoxes || itemBoxes.length !== count || itemBoxes.some((item) => item.type !== "infe")) {
    return undefined;
  }

  const items = itemBoxes.map((item) => readImageItem(input, item));

  return items.every((item) => item !== undefined) ? items : undefined;
};

const readItemReferences = (input: Buffer, box: IsoBox) => {
  const fullBox = readFullBox(input, box);

  if (!fullBox || (fullBox.version !== 0 && fullBox.version !== 1)) {
    return undefined;
  }

  const idSize = fullBox.version === 0 ? 2 : 4;
  const referenceBoxes = readBoxes(input, fullBox.dataStart, box.dataEnd);

  if (!referenceBoxes) {
    return undefined;
  }

  const subordinateItems = new Set<number>();

  for (const reference of referenceBoxes) {
    if (reference.dataEnd - reference.dataStart < idSize + 2) {
      return undefined;
    }

    const readId = (offset: number) =>
      idSize === 2 ? input.readUInt16BE(offset) : input.readUInt32BE(offset);
    const from = readId(reference.dataStart);
    const count = input.readUInt16BE(reference.dataStart + idSize);
    const referencesStart = reference.dataStart + idSize + 2;

    if (referencesStart + count * idSize !== reference.dataEnd) {
      return undefined;
    }

    if (reference.type === "auxl" || reference.type === "thmb") {
      subordinateItems.add(from);
    } else if (reference.type === "dimg") {
      for (let index = 0; index < count; index += 1) {
        subordinateItems.add(readId(referencesStart + index * idSize));
      }
    }
  }

  return subordinateItems;
};

export const inspectAvif = (input: Buffer): ImageInputInspection => {
  const boxes = readBoxes(input, 0, input.length);

  if (!boxes || boxes[0]?.type !== "ftyp") {
    return { code: "malformed_container", status: "failed" };
  }

  const brands = readFileTypeBrands(input, boxes[0]);

  if (!brands) {
    return { code: "malformed_container", status: "failed" };
  }

  if (brands.has("avis")) {
    return { code: "animated_input", status: "skipped" };
  }

  if (!brands.has("avif")) {
    return { code: "malformed_container", status: "failed" };
  }

  const metaBoxes = boxes.filter((box) => box.type === "meta");

  if (metaBoxes.length !== 1) {
    return { code: "malformed_container", status: "failed" };
  }

  const meta = metaBoxes[0];
  const metaFullBox = meta && readFullBox(input, meta);
  const metaChildren =
    meta && metaFullBox ? readBoxes(input, metaFullBox.dataStart, meta.dataEnd) : undefined;

  if (!metaChildren) {
    return { code: "malformed_container", status: "failed" };
  }

  const primaryBoxes = metaChildren.filter((box) => box.type === "pitm");
  const itemInfoBoxes = metaChildren.filter((box) => box.type === "iinf");
  const primaryBox = primaryBoxes[0];
  const itemInfoBox = itemInfoBoxes[0];

  if (primaryBoxes.length !== 1 || itemInfoBoxes.length !== 1 || !primaryBox || !itemInfoBox) {
    return { code: "malformed_container", status: "failed" };
  }

  const primaryItem = readPrimaryItem(input, primaryBox);
  const imageItems = readImageItems(input, itemInfoBox);

  if (primaryItem === undefined || !imageItems) {
    return { code: "malformed_container", status: "failed" };
  }

  const itemIds = new Set(imageItems.map((item) => item.id));
  const primary = imageItems.find((item) => item.id === primaryItem);

  if (itemIds.size !== imageItems.length || !primary || !IMAGE_ITEM_TYPES.has(primary.type)) {
    return { code: "malformed_container", status: "failed" };
  }

  const referenceBoxes = metaChildren.filter((box) => box.type === "iref");

  if (referenceBoxes.length > 1) {
    return { code: "malformed_container", status: "failed" };
  }

  const subordinateItems = referenceBoxes[0]
    ? readItemReferences(input, referenceBoxes[0])
    : new Set<number>();

  if (!subordinateItems) {
    return { code: "malformed_container", status: "failed" };
  }

  const topLevelImages = imageItems.filter(
    (item) => IMAGE_ITEM_TYPES.has(item.type) && !item.hidden && !subordinateItems.has(item.id),
  );

  return topLevelImages.length === 1 && topLevelImages[0]?.id === primaryItem
    ? { format: "avif", status: "eligible" }
    : { code: "animated_input", status: "skipped" };
};
