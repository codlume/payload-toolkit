import type { Payload } from "payload";

export const setStoredBlurHash = async (
  payload: Payload,
  id: number | string,
  blurHash: string,
) => {
  await payload.db.updateOne({
    collection: "media",
    data: { blurHash },
    id,
  });

  const { docs: versions } = await payload.findVersions({
    collection: "media",
    depth: 0,
    limit: 1,
    where: {
      and: [{ parent: { equals: id } }, { latest: { equals: true } }],
    },
  });
  const [latestVersion] = versions;

  if (!latestVersion) {
    throw new Error(`Expected media document ${id} to have a version row.`);
  }

  await payload.db.updateVersion({
    collection: "media",
    id: latestVersion.id,
    versionData: {
      version: { ...latestVersion.version, blurHash },
    },
  });
};
