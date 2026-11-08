import type {
  CollectionConfig,
  Config,
  GlobalConfig,
  Payload,
  PayloadRequest,
  Plugin,
} from "payload";

import { admin } from "./admin/index.ts";
import { lifecycle } from "./lifecycle/index.ts";
import { COLLECTION_ACCESS_KEYS, GLOBAL_ACCESS_KEYS, wrapAccess } from "./access.ts";
import {
  type Capabilities,
  type Enforcer,
  enforcerOf,
  PLUGIN_SLUG,
  type Resource,
} from "./contract.ts";
import { createRolesDiagnostics } from "./diagnostics.ts";
import { createCoreHooks, createHookTracker } from "./hooks.ts";
import { resolveOptions, RolesPluginConfigError, type RolesPluginOptions } from "./options.ts";
import { buildRegistry, describeRegistryDrift } from "./registry.ts";
import { createResolver } from "./resolve.ts";
import { createRolesCollection, createUserFields } from "./schema.ts";

type Tracker = ReturnType<typeof createHookTracker>;

type Context = { enforcer: Enforcer; tracker: Tracker };

const wrapCollectionAccess = (
  collection: CollectionConfig,
  resource: Resource,
  enforcer: Enforcer,
): NonNullable<CollectionConfig["access"]> => ({
  ...collection.access,
  ...Object.fromEntries(
    COLLECTION_ACCESS_KEYS.map((key) => [
      key,
      wrapAccess({ resource, key, app: collection.access?.[key], enforcer, lifecycle }),
    ]),
  ),
});

const wrapGlobalAccess = (
  global: GlobalConfig,
  resource: Resource,
  enforcer: Enforcer,
): NonNullable<GlobalConfig["access"]> => ({
  ...global.access,
  ...Object.fromEntries(
    GLOBAL_ACCESS_KEYS.map((key) => [
      key,
      wrapAccess({ resource, key, app: global.access?.[key], enforcer, lifecycle }),
    ]),
  ),
});

/** Admin slots win over the app's, except `beforeDocumentControls`, where both lists render. */
const mergeSlots = <Slots extends { beforeDocumentControls?: unknown[] }>(
  app: Slots | undefined,
  ours: Slots,
): Slots => {
  const controls: Slots["beforeDocumentControls"] = [
    ...(app?.beforeDocumentControls ?? []),
    ...(ours.beforeDocumentControls ?? []),
  ];
  return { ...app, ...ours, ...(controls.length > 0 && { beforeDocumentControls: controls }) };
};

const transformCollection = (
  collection: CollectionConfig,
  { enforcer, tracker }: Context,
): CollectionConfig => {
  const { options, registry } = enforcer;
  const isUsers = collection.slug === options.userCollection;
  const resource = registry.get(`collections:${collection.slug}`);
  if (!resource && !isUsers) {
    return collection;
  }
  const withFields = isUsers
    ? { ...collection, fields: [...collection.fields, ...createUserFields(enforcer)] }
    : collection;
  const core = createCoreHooks(enforcer, collection.slug);
  const lifecycleHooks =
    options.enabled && resource ? lifecycle.collectionHooks(resource, enforcer) : {};
  const edit = resource ? admin.collectionEdit(resource) : undefined;
  return {
    ...withFields,
    ...(options.enabled &&
      resource && { access: wrapCollectionAccess(collection, resource, enforcer) }),
    ...(edit && {
      admin: {
        ...withFields.admin,
        components: {
          ...withFields.admin?.components,
          edit: mergeSlots(withFields.admin?.components?.edit, edit),
        },
      },
    }),
    hooks: tracker.collection(collection.slug, collection.hooks, core, lifecycleHooks),
  };
};

const transformGlobal = (global: GlobalConfig, { enforcer, tracker }: Context): GlobalConfig => {
  const resource = enforcer.registry.get(`globals:${global.slug}`);
  if (!resource || !enforcer.options.enabled) {
    return global;
  }
  const elements = admin.globalElements(resource);
  return {
    ...global,
    access: wrapGlobalAccess(global, resource, enforcer),
    ...(elements && {
      admin: {
        ...global.admin,
        components: {
          ...global.admin?.components,
          elements: mergeSlots(global.admin?.components?.elements, elements),
        },
      },
    }),
    hooks: tracker.global(global.slug, global.hooks, lifecycle.globalHooks(resource, enforcer)),
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Mongo builds unique indexes in the background, so the bootstrap claim is only safe after the
 * users model has finished. Other adapters create indexes during schema push and skip this.
 */
const awaitUserIndexes = async (payload: Payload, slug: string) => {
  const db: unknown = payload.db;
  if (!isRecord(db) || !isRecord(db.collections)) {
    return;
  }
  const model = db.collections[slug];
  if (!isRecord(model)) {
    return;
  }
  const init: unknown = model.init;
  if (typeof init === "function") {
    await Reflect.apply(init, model, []);
  }
};

export const rolesPlugin = (options: RolesPluginOptions): Plugin => {
  const plugin: Plugin = (config: Config) => {
    const { options: resolved, problems } = resolveOptions(config, options);
    if (problems.length > 0) {
      throw new RolesPluginConfigError(problems);
    }
    const log = createRolesDiagnostics(resolved.debug);
    const rolesCollection = createRolesCollection(resolved, admin);
    const collections = [...(config.collections ?? []), rolesCollection];
    const globals = config.globals ?? [];
    const registry = buildRegistry({ collections, globals }, resolved);
    const enforcer: Enforcer = {
      options: resolved,
      registry,
      subject: createResolver({ options: resolved, registry, log }),
      log,
    };
    const tracker = createHookTracker();
    const context: Context = { enforcer, tracker };

    return {
      ...config,
      collections: collections.map((collection) => transformCollection(collection, context)),
      globals: globals.map((global) => transformGlobal(global, context)),
      custom: { ...config.custom, [PLUGIN_SLUG]: enforcer },
      onInit: async (payload) => {
        await awaitUserIndexes(payload, resolved.userCollection);
        if (!resolved.enabled) {
          log.warn(payload, "enforcement_disabled", {
            message: "payload-roles is disabled: role checks are off and app access decides alone.",
          });
        } else {
          const startupProblems = [
            ...describeRegistryDrift(registry, buildRegistry(payload.config, resolved)),
            ...tracker.verify(payload),
          ];
          if (startupProblems.length > 0) {
            throw new RolesPluginConfigError(startupProblems);
          }
          if (!lifecycle.enforcing) {
            log.warn(payload, "lifecycle_not_installed", {
              message:
                "payload-roles lifecycle enforcement is not installed: publish, unpublish, trash and readVersions grants never allow a write on their own.",
            });
          }
        }
        await config.onInit?.(payload);
      },
    };
  };

  plugin.slug = PLUGIN_SLUG;
  // Payload applies plugins in ascending `order`, so this runs after every plugin without one.
  plugin.order = Number.MAX_SAFE_INTEGER;
  return plugin;
};

/** The same answer the access layer uses. `null` for anonymous and foreign auth collections. */
export const resolveCapabilities = async (req: PayloadRequest): Promise<Capabilities | null> => {
  const subject = await enforcerOf(req.payload).subject(req);
  return subject.kind === "member" ? subject.capabilities : null;
};
