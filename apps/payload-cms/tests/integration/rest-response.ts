import { handleEndpoints, type Payload, type SanitizedConfig } from "payload";

type StoredMedia = {
  blurHash?: null | string | undefined;
  filename?: null | string | undefined;
  mimeType?: null | string | undefined;
};

export const readCreatedMedia = async (response: Response) => {
  const result: unknown = await response.json();
  const document =
    typeof result === "object" && result !== null && "doc" in result ? result.doc : result;
  const readString = (name: "blurHash" | "filename" | "mimeType") => {
    if (typeof document !== "object" || document === null) {
      return "";
    }

    const value: unknown = Reflect.get(document, name);
    return typeof value === "string" ? value : "";
  };

  return {
    blurHash: readString("blurHash"),
    filename: readString("filename"),
    mimeType: readString("mimeType"),
    status: response.status,
  };
};

export const readStoredMedia = async (config: SanitizedConfig, filename: string) => {
  const response = await handleEndpoints({
    config,
    request: new Request(`http://localhost/api/media/file/${encodeURIComponent(filename)}`),
  });

  if (!response.ok) {
    throw new Error(`Expected stored media response, received ${response.status}.`);
  }

  return Buffer.from(await response.arrayBuffer());
};

export const reuploadStoredMediaAndCompareHash = async (payload: Payload, media: StoredMedia) => {
  if (
    typeof media.blurHash !== "string" ||
    typeof media.filename !== "string" ||
    typeof media.mimeType !== "string"
  ) {
    throw new TypeError("Expected generated media metadata.");
  }

  const stored = await readStoredMedia(payload.config, media.filename);
  const repeated = await payload.create({
    collection: "media",
    data: {},
    file: {
      data: stored,
      mimetype: media.mimeType,
      name: `stored-${media.filename}`,
      size: stored.length,
    },
  });

  return {
    hashMatchesStoredBytes: media.blurHash === repeated.blurHash,
    storedMimeType: media.mimeType,
  };
};
