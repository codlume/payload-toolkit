import type { Access, CollectionConfig, Field, FieldAccess, TextFieldValidation } from "payload";
import { text } from "payload/shared";

import type { AdminModule, Enforcer, ResolvedOptions } from "./contract.ts";
import { can } from "./grants.ts";
import { sameId } from "./resolve.ts";

export const CLAIM_SENTINEL = "first";

const KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const validateKey: TextFieldValidation = (value, options) => {
  const base = text(value, options);
  if (base !== true) {
    return base;
  }
  return typeof value !== "string" || KEY_PATTERN.test(value)
    ? true
    : "Use a kebab-case key such as content-editor.";
};

export const createRolesCollection = (
  options: ResolvedOptions,
  admin: AdminModule,
): CollectionConfig => {
  /** Members of the user collection only. Grants narrow this further when enforcement is on. */
  const members: Access = ({ req }) => req.user?.collection === options.userCollection;
  return {
    slug: options.rolesSlug,
    access: {
      create: members,
      delete: members,
      read: members,
      readVersions: members,
      update: members,
    },
    admin: {
      defaultColumns: ["name", "key", "updatedAt"],
      group: "Access",
      useAsTitle: "name",
    },
    fields: [
      {
        name: "key",
        type: "text",
        index: true,
        required: true,
        unique: true,
        validate: validateKey,
      },
      { name: "name", type: "text", required: true },
      { name: "description", type: "textarea" },
      {
        name: options.permissionsField,
        type: "json",
        defaultValue: {},
        required: true,
        ...(admin.permissionsField && { admin: { components: admin.permissionsField } }),
      },
    ],
    versions: { maxPerDoc: 25 },
  };
};

const deny = () => false;

/**
 * Field access only drives the admin UI's read-only state. The users guard in hooks.ts is
 * the authority, because field access strips silently instead of refusing. Disabled mode
 * installs neither, so the fields are plain writable for whoever the app lets update a user.
 */
export const createUserFields = (enforcer: Enforcer): Field[] => {
  const { options, registry } = enforcer;
  const usersResource = registry.get(`collections:${options.userCollection}`);

  const isSuperAdmin: FieldAccess = async ({ req }) => {
    const subject = await enforcer.subject(req);
    return subject.kind === "member" && subject.capabilities.kind === "all";
  };

  const canAssignRoles: FieldAccess = async ({ doc, req }) => {
    const subject = await enforcer.subject(req);
    if (subject.kind === "outsider") {
      return false;
    }
    if (subject.capabilities.kind === "all") {
      return true;
    }
    const targetId: unknown = doc?.id;
    const isSelf =
      (typeof targetId === "string" || typeof targetId === "number") &&
      sameId(targetId, subject.id);
    const hasUpdate = usersResource ? can(subject.capabilities, usersResource.id, "update") : true;
    return hasUpdate && !isSelf;
  };

  return [
    {
      name: options.rolesField,
      type: "relationship",
      ...(options.enabled && { access: { create: canAssignRoles, update: canAssignRoles } }),
      admin: { position: "sidebar" },
      hasMany: true,
      maxDepth: 0,
      relationTo: options.rolesSlug,
      saveToJWT: false,
    },
    {
      name: options.superAdminField,
      type: "checkbox",
      ...(options.enabled && { access: { create: isSuperAdmin, update: isSuperAdmin } }),
      admin: {
        description: "Super admins bypass role checks. The app's own access functions still apply.",
        position: "sidebar",
      },
      defaultValue: false,
      saveToJWT: false,
    },
    {
      name: options.claimField,
      type: "text",
      access: { create: deny, update: deny },
      hidden: true,
      index: true,
      unique: true,
    },
  ];
};
