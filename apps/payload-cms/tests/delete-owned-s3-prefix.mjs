import { DeleteObjectsCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";

/**
 * @param {{ bucket: string, client: import("@aws-sdk/client-s3").S3Client, prefix: string }} options
 */
export const deleteOwnedS3Prefix = async ({ bucket, client, prefix }) => {
  try {
    if (!prefix.startsWith("tests/") || prefix.length <= "tests/".length) {
      throw new Error(`Refusing to delete unowned S3 prefix: ${prefix}`);
    }

    const listed = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1_000, Prefix: `${prefix}/` }),
    );

    if (listed.IsTruncated) {
      throw new Error(
        `Refusing incomplete cleanup of S3 prefix with over 1,000 objects: ${prefix}`,
      );
    }

    const objects = listed.Contents?.flatMap(({ Key }) => (Key ? [{ Key }] : [])) ?? [];

    if (objects.length > 0) {
      await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    }
  } finally {
    client.destroy();
  }
};
