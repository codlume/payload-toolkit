import { expect, test } from "vitest";

import { dependencyVersions } from "../../../../tests/compat/versions.mjs";

test("clean consumers pin compatible AWS storage packages", () => {
  const clientVersion = dependencyVersions["@aws-sdk/client-s3"];
  const storageVersion = dependencyVersions["@aws-sdk/lib-storage"];

  expect(storageVersion).toMatch(/^\d+\.\d+\.\d+$/u);
  expect(clientVersion).toBe(storageVersion);
});
