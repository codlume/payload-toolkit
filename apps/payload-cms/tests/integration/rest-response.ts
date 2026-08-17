import { handleEndpoints, type SanitizedConfig } from "payload";

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
