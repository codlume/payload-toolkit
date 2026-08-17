import { S3Client } from "@aws-sdk/client-s3";

import { deleteOwnedS3Prefix } from "./delete-owned-s3-prefix.mjs";

export const s3TestBucket = "payload-blurhash";
export const s3TestEndpoint = process.env.PAYLOAD_S3_ENDPOINT ?? "http://127.0.0.1:4566";

const credentials = {
  accessKeyId: "test",
  secretAccessKey: "test",
};

export const createS3TestStorage = (prefix: string) => ({
  bucket: s3TestBucket,
  config: {
    credentials,
    endpoint: s3TestEndpoint,
    forcePathStyle: true,
    region: "us-east-1",
  },
  prefix,
});

export const createS3TestClient = () =>
  new S3Client({
    credentials,
    endpoint: s3TestEndpoint,
    forcePathStyle: true,
    region: "us-east-1",
  });

export const deleteS3TestPrefix = (prefix: string) =>
  deleteOwnedS3Prefix({ bucket: s3TestBucket, client: createS3TestClient(), prefix });
