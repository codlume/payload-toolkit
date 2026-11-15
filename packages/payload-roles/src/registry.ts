import {
  ACTION_IDS,
  type ActionId,
  type Registry,
  type Resource,
  type ResolvedOptions,
} from "./contract.ts";

type Shape = Omit<Resource, "actions" | "id">;

/** Config fields the registry reads. Raw and sanitized Payload configs both satisfy it. */
type VersionsShape = { drafts?: boolean | object | undefined };
type AuthShape = { maxLoginAttempts?: number | undefined };

export type CollectionShapeSource = {
  slug: string;
  auth?: AuthShape | boolean | undefined;
  trash?: boolean | undefined;
  versions?: boolean | undefined | VersionsShape;
};

export type GlobalShapeSource = {
  slug: string;
  versions?: boolean | undefined | VersionsShape;
};

export type RegistrySource = {
  collections?: readonly CollectionShapeSource[] | undefined;
  globals?: readonly GlobalShapeSource[] | undefined;
};

const APPLIES = {
  read: () => true,
  create: (shape) => shape.kind === "collection",
  update: () => true,
  delete: (shape) => shape.kind === "collection",
  trash: (shape) => shape.trash,
  publish: (shape) => shape.drafts,
  unpublish: (shape) => shape.drafts,
  readVersions: (shape) => shape.versions,
  unlock: (shape) => shape.unlock,
} satisfies Record<ActionId, (shape: Shape) => boolean>;

const hasDrafts = (versions: CollectionShapeSource["versions"]) =>
  typeof versions === "object" && Boolean(versions.drafts);

// Payload defaults `maxLoginAttempts` to 5, so only an explicit 0 removes the lock fields.
const hasUnlock = (auth: CollectionShapeSource["auth"]) =>
  Boolean(auth) && (typeof auth !== "object" || auth.maxLoginAttempts !== 0);

const collectionShape = (collection: CollectionShapeSource): Shape => ({
  kind: "collection",
  slug: collection.slug,
  drafts: hasDrafts(collection.versions),
  trash: Boolean(collection.trash),
  versions: Boolean(collection.versions),
  auth: Boolean(collection.auth),
  unlock: hasUnlock(collection.auth),
});

const globalShape = (global: GlobalShapeSource): Shape => ({
  kind: "global",
  slug: global.slug,
  drafts: hasDrafts(global.versions),
  trash: false,
  versions: Boolean(global.versions),
  auth: false,
  unlock: false,
});

const toResource = (shape: Shape): Resource => ({
  ...shape,
  id: `${shape.kind}s:${shape.slug}`,
  actions: new Set(ACTION_IDS.filter((action) => APPLIES[action](shape))),
});

export const isApplicable = (resource: Resource, action: ActionId) => resource.actions.has(action);

export const buildRegistry = (
  source: RegistrySource,
  options: Pick<ResolvedOptions, "collections" | "globals" | "rolesSlug">,
): Registry => {
  const managedCollections = new Set([...options.collections, options.rolesSlug]);
  const managedGlobals = new Set(options.globals);
  const resources = [
    ...(source.collections ?? [])
      .filter((collection) => managedCollections.has(collection.slug))
      .map(collectionShape),
    ...(source.globals ?? []).filter((global) => managedGlobals.has(global.slug)).map(globalShape),
  ].map(toResource);
  return new Map(resources.map((resource) => [resource.id, resource]));
};

/** Flags whose drift between config time and init time changes which actions apply. */
export const describeRegistryDrift = (expected: Registry, actual: Registry): string[] => {
  const problems: string[] = [];
  for (const [id, resource] of expected) {
    const current = actual.get(id);
    if (!current) {
      problems.push(`Managed resource "${id}" is missing from the sanitized config.`);
      continue;
    }
    for (const flag of ["drafts", "trash", "versions", "auth", "unlock"] as const) {
      if (resource[flag] !== current[flag]) {
        problems.push(
          `"${id}" changed \`${flag}\` from ${String(resource[flag])} to ${String(current[flag])} after the roles plugin ran. Register rolesPlugin after the plugin that changes it.`,
        );
      }
    }
  }
  for (const id of actual.keys()) {
    if (!expected.has(id)) {
      problems.push(`Managed resource "${id}" appeared after the roles plugin ran.`);
    }
  }
  return problems;
};
