import type { CollectionConfig, CollectionSlug, Config, Field, GlobalSlug } from "payload";

import { PLUGIN_SLUG, type ResolvedOptions } from "./contract.ts";

export type RolesPluginOptions = {
  /** Managed collections. The roles collection is always managed. */
  collections?: CollectionSlug[];
  globals?: GlobalSlug[];
  /** Default: Payload's admin user collection. */
  userCollection?: CollectionSlug;
  /** Default "roles". */
  rolesSlug?: string;
  /** Default "roles". */
  rolesField?: string;
  /** Default "superAdmin". */
  superAdminField?: string;
  /** Default true. `false` keeps the schema and turns enforcement off. */
  enabled?: boolean;
  /** Default false. */
  debug?: boolean;
};

export class RolesPluginConfigError extends Error {
  override name = "RolesPluginConfigError";

  constructor(problems: readonly string[]) {
    super(`Invalid Roles plugin configuration:\n${problems.map((p) => `- ${p}`).join("\n")}`);
  }
}

export const SYSTEM_COLLECTIONS: ReadonlySet<string> = new Set([
  "payload-jobs",
  "payload-kv",
  "payload-locked-documents",
  "payload-migrations",
  "payload-preferences",
]);

/** Field names Payload or its auth strategies own on an auth collection. */
const RESERVED_USER_FIELDS: ReadonlySet<string> = new Set([
  "_verificationToken",
  "_verified",
  "apiKey",
  "apiKeyIndex",
  "collection",
  "createdAt",
  "deletedAt",
  "email",
  "enableAPIKey",
  "hash",
  "id",
  "lockUntil",
  "loginAttempts",
  "password",
  "resetPasswordExpiration",
  "resetPasswordRequestedAt",
  "resetPasswordToken",
  "salt",
  "sessions",
  "updatedAt",
  "username",
]);

const formatValue = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const resolveSlugs = (value: unknown, name: "collections" | "globals", problems: string[]) => {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    problems.push(`\`${name}\` must be an array of ${name.slice(0, -1)} slugs.`);
    return [];
  }
  const slugs: string[] = [];
  const duplicates = new Set<string>();
  value.forEach((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      problems.push(
        `\`${name}[${index}]\` must be a non-empty string; received ${formatValue(slug)}.`,
      );
    } else if (slugs.includes(slug)) {
      if (!duplicates.has(slug)) {
        problems.push(`\`${name}\` must not contain duplicate slug "${slug}".`);
        duplicates.add(slug);
      }
    } else {
      slugs.push(slug);
    }
  });
  return slugs;
};

const resolveName = (
  value: unknown,
  fallback: string,
  name: "rolesField" | "rolesSlug" | "superAdminField" | "userCollection",
  problems: string[],
) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`\`${name}\` must be a non-empty string; received ${formatValue(value)}.`);
    return fallback;
  }
  if (name !== "userCollection" && name !== "rolesSlug" && !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    problems.push(
      `\`${name}\` "${value}" must start with a letter and contain only letters, numbers, or underscores.`,
    );
  }
  return value;
};

const resolveBoolean = (
  value: unknown,
  fallback: boolean,
  name: "debug" | "enabled",
  problems: string[],
) => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    problems.push(`\`${name}\` must be a boolean; received ${formatValue(value)}.`);
    return fallback;
  }
  return value;
};

const hasTopLevelDataField = (fields: Field[], fieldName: string): boolean =>
  fields.some((field) => {
    if ("name" in field && typeof field.name === "string") {
      return field.name === fieldName;
    }
    if (field.type === "row" || field.type === "collapsible") {
      return hasTopLevelDataField(field.fields, fieldName);
    }
    if (field.type === "tabs") {
      return field.tabs.some((tab) =>
        "name" in tab && typeof tab.name === "string"
          ? tab.name === fieldName
          : hasTopLevelDataField(tab.fields, fieldName),
      );
    }
    return false;
  });

const hasLocalizedStatus = (collection: Pick<CollectionConfig, "versions">) =>
  typeof collection.versions === "object" &&
  typeof collection.versions.drafts === "object" &&
  collection.versions.drafts.localizeStatus === true;

export const resolveOptions = (
  config: Pick<Config, "admin" | "collections" | "globals" | "plugins">,
  options: RolesPluginOptions,
): { options: ResolvedOptions; problems: string[] } => {
  const problems: string[] = [];
  const collections = resolveSlugs(options.collections, "collections", problems);
  const globals = resolveSlugs(options.globals, "globals", problems);
  const rolesSlug = resolveName(options.rolesSlug, "roles", "rolesSlug", problems);
  const rolesField = resolveName(options.rolesField, "roles", "rolesField", problems);
  const superAdminField = resolveName(
    options.superAdminField,
    "superAdmin",
    "superAdminField",
    problems,
  );
  const claimField = "rolesBootstrapClaim";
  const enabled = resolveBoolean(options.enabled, true, "enabled", problems);
  const debug = resolveBoolean(options.debug, false, "debug", problems);

  const registrations = config.plugins?.filter((plugin) => plugin.slug === PLUGIN_SLUG).length ?? 0;
  if (registrations > 1) {
    problems.push(`Register \`rolesPlugin\` only once; found ${registrations} registrations.`);
  }

  const available = new Map(config.collections?.map((collection) => [collection.slug, collection]));
  if (available.has(rolesSlug)) {
    problems.push(`\`rolesSlug\` "${rolesSlug}" is already a collection; choose another slug.`);
  }

  const userCollection = resolveName(
    options.userCollection,
    config.admin?.user ??
      config.collections?.find((collection) => collection.auth)?.slug ??
      "users",
    "userCollection",
    problems,
  );
  const users = available.get(userCollection);
  if (!users) {
    problems.push(`User collection "${userCollection}" does not exist.`);
  } else if (!users.auth) {
    problems.push(`User collection "${userCollection}" must be auth-enabled.`);
  } else {
    // The guards judge the main row, while duplicate and publish start from the latest draft.
    if (typeof users.versions === "object" && users.versions.drafts) {
      problems.push(
        `User collection "${userCollection}" uses \`versions.drafts\`, which the roles plugin does not support.`,
      );
    }
    const names = new Set([rolesField, superAdminField, claimField]);
    if (names.size < 3) {
      problems.push(
        "`rolesField`, `superAdminField`, and the bootstrap claim field must have distinct names.",
      );
    }
    for (const name of names) {
      if (RESERVED_USER_FIELDS.has(name)) {
        problems.push(`Field "${name}" on "${userCollection}" is reserved by Payload.`);
      } else if (hasTopLevelDataField(users.fields, name)) {
        problems.push(
          `Collection "${userCollection}" already has a top-level field named "${name}".`,
        );
      }
    }
  }

  for (const slug of collections) {
    if (slug === rolesSlug) {
      continue;
    }
    const collection = available.get(slug);
    if (SYSTEM_COLLECTIONS.has(slug)) {
      problems.push(`Collection "${slug}" is a Payload system collection and cannot be managed.`);
    } else if (!collection) {
      problems.push(`Collection "${slug}" does not exist.`);
    } else if (hasLocalizedStatus(collection)) {
      problems.push(
        `Collection "${slug}" uses \`versions.drafts.localizeStatus\`, which the roles plugin does not support.`,
      );
    }
  }

  const availableGlobals = new Set(config.globals?.map((global) => global.slug));
  for (const slug of globals) {
    if (!availableGlobals.has(slug)) {
      problems.push(`Global "${slug}" does not exist.`);
    } else if (hasLocalizedStatus(config.globals?.find((global) => global.slug === slug) ?? {})) {
      problems.push(
        `Global "${slug}" uses \`versions.drafts.localizeStatus\`, which the roles plugin does not support.`,
      );
    }
  }

  if (collections.length === 0 && globals.length === 0) {
    problems.push("Configure at least one managed target with `collections` or `globals`.");
  }

  return {
    options: {
      collections,
      globals,
      userCollection,
      rolesSlug,
      rolesField,
      superAdminField,
      claimField,
      permissionsField: "permissions",
      enabled,
      debug,
    },
    problems,
  };
};
