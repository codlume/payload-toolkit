export const pnpmVersion = "10.34.5";

export const dependencyVersions = Object.freeze({
  "@aws-sdk/client-s3": "3.1112.0",
  "@aws-sdk/lib-storage": "3.1112.0",
  "@payloadcms/db-sqlite": "3.88.0",
  "@payloadcms/next": "3.88.0",
  "@payloadcms/storage-s3": "3.88.0",
  "@payloadcms/ui": "3.88.0",
  "@playwright/test": "1.58.2",
  "@types/node": "26.2.0",
  "@types/react": "19.2.18",
  "@types/react-dom": "19.2.3",
  blurhash: "2.0.5",
  esbuild: "0.28.2",
  graphql: "16.14.2",
  next: "15.4.11",
  payload: "3.88.0",
  react: "19.2.8",
  "react-dom": "19.2.8",
  sharp: "0.35.3",
  typescript: "5.9.3",
  vitest: "4.1.9",
});

export const compatibilityLanes = Object.freeze([
  Object.freeze({ name: "minimum", node: "22.12.0", payload: "3.88.0" }),
  Object.freeze({ name: "current", node: "24.13.1", payload: "3.88.0" }),
]);
