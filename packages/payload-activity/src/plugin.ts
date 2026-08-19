import type {
  CollectionConfig,
  CollectionSlug,
  Config,
  Field,
  FieldHook,
  GlobalSlug,
  Plugin,
  RelationshipField,
} from "payload";

type ActivityTargets =
  | { collections: CollectionSlug[]; globals?: GlobalSlug[] }
  | { collections?: CollectionSlug[]; globals: GlobalSlug[] };

export type ActivityPluginOptions = ActivityTargets & {
  debug?: boolean;
  enabled?: boolean;
  fieldName?: string;
};

type ResolvedOptions = {
  adminUserCollection: CollectionSlug;
  collections: string[];
  debug: boolean;
  enabled: boolean;
  fieldName: string;
  globals: string[];
};

const PLUGIN_SLUG = "@codlume/payload-activity";
const PAYLOAD_OWNED_FIELD_NAMES = new Set([
  "__v",
  "_status",
  "createdAt",
  "deletedAt",
  "file",
  "filename",
  "filesize",
  "focalX",
  "focalY",
  "height",
  "id",
  "mimeType",
  "prefix",
  "sizes",
  "thumbnailURL",
  "updatedAt",
  "url",
  "width",
]);
const AUTH_BASE_FIELD_NAMES = new Set([
  "collection",
  "email",
  "hash",
  "password",
  "resetPasswordExpiration",
  "resetPasswordToken",
  "salt",
]);
const AUTH_API_KEY_FIELD_NAMES = new Set(["apiKey", "apiKeyIndex", "enableAPIKey"]);
const AUTH_VERIFICATION_FIELD_NAMES = new Set(["_verificationToken", "_verified"]);
const AUTH_ACCOUNT_LOCK_FIELD_NAMES = new Set(["lockUntil", "loginAttempts"]);

class ActivityPluginConfigError extends Error {
  override name = "ActivityPluginConfigError";

  constructor(problems: string[]) {
    super(
      `Invalid Activity plugin configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
}

const formatValue = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

const resolveTargetSlugs = (
  value: unknown,
  name: "collections" | "globals",
  problems: string[],
) => {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length === 0) {
    problems.push(`\`${name}\` must be a non-empty array of ${name.slice(0, -1)} slugs.`);
    return [];
  }

  const collections: string[] = [];
  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();

  value.forEach((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      problems.push(
        `\`${name}[${index}]\` must be a non-empty string; received ${formatValue(slug)}.`,
      );
      return;
    }

    if (seen.has(slug)) {
      if (!reportedDuplicates.has(slug)) {
        problems.push(`\`${name}\` must not contain duplicate slug "${slug}".`);
        reportedDuplicates.add(slug);
      }
      return;
    }

    seen.add(slug);
    collections.push(slug);
  });

  return collections;
};

const resolveFieldName = (value: unknown, problems: string[]) => {
  const fieldName = value === undefined ? "lastModifiedBy" : value;

  if (typeof fieldName !== "string") {
    problems.push(`\`fieldName\` must be a string; received ${formatValue(fieldName)}.`);
    return "lastModifiedBy";
  }

  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(fieldName)) {
    problems.push(
      `\`fieldName\` "${fieldName}" must start with a letter and contain only letters, numbers, or underscores.`,
    );
  }

  if (PAYLOAD_OWNED_FIELD_NAMES.has(fieldName)) {
    problems.push(
      `\`fieldName\` "${fieldName}" is reserved by Payload; choose a plugin-owned field name.`,
    );
  }

  return fieldName;
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

const hasPayloadAuthField = (collection: CollectionConfig, fieldName: string) => {
  if (!collection.auth) {
    return false;
  }

  const auth = collection.auth === true ? {} : collection.auth;

  if (auth.useAPIKey && AUTH_API_KEY_FIELD_NAMES.has(fieldName)) {
    return true;
  }

  const localFieldsEnabled =
    !auth.disableLocalStrategy ||
    (typeof auth.disableLocalStrategy === "object" && auth.disableLocalStrategy.enableFields);

  if (!localFieldsEnabled) {
    return false;
  }

  return (
    AUTH_BASE_FIELD_NAMES.has(fieldName) ||
    (Boolean(auth.loginWithUsername) && fieldName === "username") ||
    (Boolean(auth.verify) && AUTH_VERIFICATION_FIELD_NAMES.has(fieldName)) ||
    ((auth.maxLoginAttempts === undefined || auth.maxLoginAttempts > 0) &&
      AUTH_ACCOUNT_LOCK_FIELD_NAMES.has(fieldName)) ||
    (auth.useSessions !== false && fieldName === "sessions")
  );
};

const findConfigurationProblems = (
  config: Config,
  options: ActivityPluginOptions,
): { options: ResolvedOptions; problems: string[] } => {
  const problems: string[] = [];
  const collections = resolveTargetSlugs(options.collections, "collections", problems);
  const globals = resolveTargetSlugs(options.globals, "globals", problems);

  if (options.collections === undefined && options.globals === undefined) {
    problems.push("Configure at least one target with `collections` or `globals`.");
  }

  const fieldName = resolveFieldName(options.fieldName, problems);
  const enabled = resolveBoolean(options.enabled, true, "enabled", problems);
  const debug = resolveBoolean(options.debug, false, "debug", problems);
  const registrationCount =
    config.plugins?.filter((plugin) => plugin.slug === PLUGIN_SLUG).length ?? 0;

  if (registrationCount > 1) {
    problems.push(
      `Register \`activityPlugin\` only once; found ${registrationCount} registrations.`,
    );
  }

  const availableCollections = new Map(
    config.collections?.map((collection) => [collection.slug, collection]),
  );
  const folderFieldName =
    config.folders === false ? undefined : (config.folders?.fieldName ?? "folder");

  for (const slug of collections) {
    const collection = availableCollections.get(slug);

    if (!collection) {
      problems.push(`Collection "${slug}" does not exist.`);
      continue;
    }

    if (collection.folders && folderFieldName === fieldName) {
      problems.push(
        `Collection "${slug}" reserves the top-level field "${fieldName}" for Payload folders.`,
      );
    }

    if (hasPayloadAuthField(collection, fieldName)) {
      problems.push(
        `Collection "${slug}" reserves the top-level field "${fieldName}" for Payload authentication.`,
      );
    }

    if (hasTopLevelDataField(collection.fields, fieldName)) {
      problems.push(
        `Collection "${slug}" already has a top-level data-bearing field named "${fieldName}".`,
      );
    }
  }

  const availableGlobals = new Map(config.globals?.map((global) => [global.slug, global]));

  for (const slug of globals) {
    const global = availableGlobals.get(slug);

    if (!global) {
      problems.push(`Global "${slug}" does not exist.`);
      continue;
    }

    if (hasTopLevelDataField(global.fields, fieldName)) {
      problems.push(
        `Global "${slug}" already has a top-level data-bearing field named "${fieldName}".`,
      );
    }
  }

  const adminUserCollection = config.admin?.user ?? "users";
  const adminCollection = availableCollections.get(adminUserCollection);

  if (!adminCollection) {
    problems.push(`Admin user collection "${adminUserCollection}" does not exist.`);
  } else if (!adminCollection.auth) {
    problems.push(`Admin user collection "${adminUserCollection}" must be auth-enabled.`);
  }

  return {
    options: {
      adminUserCollection,
      collections,
      debug,
      enabled,
      fieldName,
      globals,
    },
    problems,
  };
};

const denyCallerWrite = () => false;

const createAttributionHook =
  (enabled: boolean, adminUserCollection: CollectionSlug): FieldHook =>
  ({ previousValue, req }) => {
    if (!enabled) {
      return previousValue ?? null;
    }

    const user = req.user;
    return user?.collection === adminUserCollection && user.id != null ? user.id : null;
  };

const createActivityField = ({ adminUserCollection, enabled, fieldName }: ResolvedOptions) =>
  ({
    access: {
      create: denyCallerWrite,
      update: denyCallerWrite,
    },
    admin: {
      ...(!enabled && { hidden: true }),
      position: "sidebar",
      readOnly: true,
    },
    hooks: { beforeChange: [createAttributionHook(enabled, adminUserCollection)] },
    label: "Last Modified By",
    localized: false,
    name: fieldName,
    relationTo: adminUserCollection,
    required: false,
    type: "relationship",
  }) satisfies RelationshipField;

const createTargetTransformer = <Target extends { fields: Field[]; slug: string }>(
  configuredSlugs: string[],
  activityField: RelationshipField,
) => {
  const configuredTargets = new Set(configuredSlugs);

  return (target: Target): Target => {
    if (!configuredTargets.has(target.slug)) {
      return target;
    }

    return {
      ...target,
      fields: [...target.fields, activityField],
    };
  };
};

export const activityPlugin = (options: ActivityPluginOptions): Plugin => {
  const plugin: Plugin = (config: Config) => {
    const { options: resolvedOptions, problems } = findConfigurationProblems(config, options);

    if (problems.length > 0) {
      throw new ActivityPluginConfigError(problems);
    }

    const activityField = createActivityField(resolvedOptions);

    return {
      ...config,
      collections: (config.collections ?? []).map(
        createTargetTransformer(resolvedOptions.collections, activityField),
      ),
      globals: (config.globals ?? []).map(
        createTargetTransformer(resolvedOptions.globals, activityField),
      ),
    };
  };

  plugin.slug = PLUGIN_SLUG;
  return plugin;
};
