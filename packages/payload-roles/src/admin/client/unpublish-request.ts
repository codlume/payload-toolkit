import { formatAdminURL } from "payload/shared";

export type UnpublishTarget = { method: "patch" | "post"; url: string };

const QUERY = "?depth=0&fallback-locale=null&unpublishAllLocales=true";

/** The request Payload's stock all-locales Unpublish sends. Null for an unsaved collection doc. */
export const unpublishTarget = ({
  api,
  serverURL,
  collectionSlug,
  globalSlug,
  id,
}: {
  api: string;
  serverURL: string;
  collectionSlug?: string | undefined;
  globalSlug?: string | undefined;
  id?: number | string | undefined;
}): UnpublishTarget | null => {
  if (collectionSlug) {
    return id === undefined
      ? null
      : {
          method: "patch",
          url: formatAdminURL({
            apiRoute: api,
            path: `/${collectionSlug}/${encodeURIComponent(id)}${QUERY}`,
            serverURL,
          }),
        };
  }
  if (globalSlug) {
    return {
      method: "post",
      url: formatAdminURL({ apiRoute: api, path: `/globals/${globalSlug}${QUERY}`, serverURL }),
    };
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const nonEmpty = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

/** The message Payload's stock Unpublish shows for a failed response body, in its precedence. */
export const unpublishErrorOf = (json: unknown): string | null => {
  if (!isRecord(json)) {
    return null;
  }
  const first: unknown = Array.isArray(json.errors) ? json.errors[0] : undefined;
  return (isRecord(first) ? nonEmpty(first.message) : null) ?? nonEmpty(json.error);
};
