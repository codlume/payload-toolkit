import type { AdminModule, Resource } from "../contract.ts";

const unpublishSlots = ({ drafts, id }: Resource) =>
  drafts
    ? {
        UnpublishButton: {
          path: "@codlume/payload-roles#UnpublishSlot",
          serverProps: { resource: id },
        },
        beforeDocumentControls: [
          { path: "@codlume/payload-roles#UnpublishControl", serverProps: { resource: id } },
        ],
      }
    : undefined;

export const admin: AdminModule = {
  permissionsField: { Field: "@codlume/payload-roles#PermissionsField" },
  collectionEdit: unpublishSlots,
  globalElements: unpublishSlots,
};
