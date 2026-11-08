// Seeded by core. Owned by the matrix thread from here on. The server components load these
// through a dynamic import of `@codlume/payload-roles/client`, never through the import map.
export { PermissionsMatrix } from "./client/permissions-matrix.tsx";
export { UnpublishDocument } from "./client/unpublish-document.tsx";
