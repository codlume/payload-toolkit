export const readCreatedBlurHash = async (response: Response) => {
  const result: unknown = await response.json();
  const document =
    typeof result === "object" && result !== null && "doc" in result ? result.doc : result;
  const blurHash =
    typeof document === "object" &&
    document !== null &&
    "blurHash" in document &&
    typeof document.blurHash === "string"
      ? document.blurHash
      : "";

  return { blurHash, status: response.status };
};
