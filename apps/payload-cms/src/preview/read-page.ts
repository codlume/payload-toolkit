import { getPayload } from "payload";
import config from "../payload.config.ts";

/** Draft cookies enable preview rendering only for an authenticated Payload user. */
export const readPage = async (slug: string, draftRequested: boolean, requestHeaders: Headers) => {
  const payload = await getPayload({ config });
  const { user } = await payload.auth({ headers: requestHeaders });
  const draft = draftRequested && Boolean(user);
  const result = await payload.find({
    collection: "pages",
    where: { slug: { equals: slug }, ...(!draft ? { _status: { equals: "published" } } : {}) },
    draft,
    overrideAccess: false,
    user,
    limit: 1,
    depth: 0,
  });
  return { page: result.docs[0], draft };
};
