import { availableParallelism } from "node:os";

import type {
  CollectionConfig,
  Config,
  Field,
  FieldHook,
  Plugin,
  SharpDependency,
  TextField,
  UploadCollectionSlug,
} from "payload";

import { createBlurHashGenerator } from "./generate-blur-hash.ts";
import { createGenerationDiagnostics } from "./generation-diagnostics.ts";

export type BlurHashPluginOptions = {
  alphaBackground?: { b: number; g: number; r: number };
  collections: UploadCollectionSlug[];
  debug?: boolean;
  enabled?: boolean;
  fieldName?: string;
  limits?: {
    concurrency?: number;
    maxInputBytes?: number;
    maxInputPixels?: number;
    maxInputSide?: number;
    timeoutSeconds?: number;
  };
};

type ResolvedOptions = {
  alphaBackground: { b: number; g: number; r: number };
  collections: string[];
  debug: boolean;
  enabled: boolean;
  fieldName: string;
  limits: {
    concurrency: number;
    maxInputBytes: number;
    maxInputPixels: number;
    maxInputSide: number;
    timeoutSeconds: number;
  };
};

type GenerationRuntime = {
  diagnostics: ReturnType<typeof createGenerationDiagnostics>;
  enabled: boolean;
  generator: ReturnType<typeof createBlurHashGenerator> | undefined;
  sharp: SharpDependency | undefined;
};

const PLUGIN_SLUG = "@codlume/payload-blurhash";
const DEFAULT_ALPHA_BACKGROUND = { b: 255, g: 255, r: 255 };
const DEFAULT_LIMITS = {
  concurrency: availableParallelism() === 1 ? 1 : 2,
  maxInputBytes: 25 * 1024 * 1024,
  maxInputPixels: 40_000_000,
  maxInputSide: 16_384,
  timeoutSeconds: 10,
};
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
  "sizes",
  "thumbnailURL",
  "updatedAt",
  "url",
  "width",
]);
const LIMIT_NAMES = [
  "concurrency",
  "maxInputBytes",
  "maxInputPixels",
  "maxInputSide",
  "timeoutSeconds",
] as const;

class BlurHashPluginConfigError extends Error {
  override name = "BlurHashPluginConfigError";

  constructor(problems: string[]) {
    super(
      `Invalid BlurHash plugin configuration:\n${problems.map((problem) => `- ${problem}`).join("\n")}`,
    );
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const formatValue = (value: unknown) =>
  typeof value === "string" ? JSON.stringify(value) : String(value);

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

const resolveCollections = (value: unknown, problems: string[]) => {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("`collections` must be a non-empty array of upload collection slugs.");
    return [];
  }

  const collections: string[] = [];
  const seen = new Set<string>();
  const reportedDuplicates = new Set<string>();

  value.forEach((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      problems.push(
        `\`collections[${index}]\` must be a non-empty string; received ${formatValue(slug)}.`,
      );
      return;
    }

    if (seen.has(slug)) {
      if (!reportedDuplicates.has(slug)) {
        problems.push(`\`collections\` must not contain duplicate slug "${slug}".`);
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
  const fieldName = value === undefined ? "blurHash" : value;

  if (typeof fieldName !== "string") {
    problems.push(`\`fieldName\` must be a string; received ${formatValue(fieldName)}.`);
    return "blurHash";
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

const resolveAlphaBackground = (value: unknown, problems: string[]) => {
  if (value === undefined) {
    return { ...DEFAULT_ALPHA_BACKGROUND };
  }

  if (!isRecord(value)) {
    problems.push("`alphaBackground` must be an object with `r`, `g`, and `b` channels.");
    return { ...DEFAULT_ALPHA_BACKGROUND };
  }

  const background = { ...DEFAULT_ALPHA_BACKGROUND };

  for (const channel of ["r", "g", "b"] as const) {
    const channelValue = value[channel];

    if (!Number.isInteger(channelValue) || Number(channelValue) < 0 || Number(channelValue) > 255) {
      problems.push(
        `\`alphaBackground.${channel}\` must be an integer from 0 through 255; received ${formatValue(channelValue)}.`,
      );
      continue;
    }

    background[channel] = Number(channelValue);
  }

  return background;
};

const resolveLimits = (value: unknown, problems: string[]) => {
  if (value === undefined) {
    return { ...DEFAULT_LIMITS };
  }

  if (!isRecord(value)) {
    problems.push("`limits` must be an object when provided.");
    return { ...DEFAULT_LIMITS };
  }

  const limits = { ...DEFAULT_LIMITS };

  for (const name of LIMIT_NAMES) {
    const limit = value[name];

    if (limit === undefined) {
      continue;
    }

    if (!Number.isSafeInteger(limit) || Number(limit) <= 0) {
      problems.push(
        `\`limits.${name}\` must be a positive safe integer; received ${formatValue(limit)}.`,
      );
      continue;
    }

    limits[name] = Number(limit);
  }

  return limits;
};

const hasTopLevelDataField = (fields: Field[], fieldName: string): boolean =>
  fields.some((field) => {
    if ("name" in field && typeof field.name === "string") {
      return field.name === fieldName;
    }

    if (field.type === "tabs") {
      return field.tabs.some((tab) => {
        if ("name" in tab && typeof tab.name === "string") {
          return tab.name === fieldName;
        }

        return hasTopLevelDataField(tab.fields, fieldName);
      });
    }

    return "fields" in field && hasTopLevelDataField(field.fields, fieldName);
  });

const findConfigurationProblems = (
  config: Config,
  options: BlurHashPluginOptions,
): { options: ResolvedOptions; problems: string[] } => {
  const problems: string[] = [];
  const collections = resolveCollections(options.collections, problems);
  const fieldName = resolveFieldName(options.fieldName, problems);
  const alphaBackground = resolveAlphaBackground(options.alphaBackground, problems);
  const limits = resolveLimits(options.limits, problems);
  const enabled = resolveBoolean(options.enabled, true, "enabled", problems);
  const debug = resolveBoolean(options.debug, false, "debug", problems);
  const registrationCount =
    config.plugins?.filter((plugin) => plugin.slug === PLUGIN_SLUG).length ?? 0;

  if (registrationCount > 1) {
    problems.push(
      `Register \`blurHashPlugin\` only once; found ${registrationCount} registrations.`,
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

    if (!collection.upload) {
      problems.push(`Collection "${slug}" must be upload-enabled.`);
      continue;
    }

    if (collection.folders && folderFieldName === fieldName) {
      problems.push(
        `Collection "${slug}" reserves the top-level field "${fieldName}" for Payload folders.`,
      );
    }

    if (hasTopLevelDataField(collection.fields, fieldName)) {
      problems.push(
        `Collection "${slug}" already has a top-level data-bearing field named "${fieldName}".`,
      );
    }
  }

  if (enabled && !config.sharp) {
    problems.push(
      "Enabled generation requires Payload's `sharp` option; configure it or set `enabled: false`.",
    );
  }

  return {
    options: {
      alphaBackground,
      collections,
      debug,
      enabled,
      fieldName,
      limits,
    },
    problems,
  };
};

const denyCallerWrite = () => false;

const isFileRemoval = (data: Record<string, unknown> | undefined) => data?.filename === null;

const createBlurHashLifecycleHook =
  (runtime: GenerationRuntime, collectionSlug: string): FieldHook =>
  async (args) => {
    if (isFileRemoval(args.data)) {
      return null;
    }

    if (!args.req.file) {
      return args.previousValue ?? null;
    }

    const sharp = args.req.payload.config.sharp ?? runtime.sharp;

    if (!runtime.enabled || !runtime.generator || !sharp || !args.req.file.data) {
      return null;
    }

    const finishDiagnostics = runtime.diagnostics.start({
      collection: collectionSlug,
      height: args.data?.height,
      inputBytes: args.req.file.data.length,
      logger: args.req.payload.logger,
      mimeType: args.data?.mimeType,
      width: args.data?.width,
    });

    try {
      const outcome = await runtime.generator.generate({
        input: args.req.file.data,
        mimeType: args.data?.mimeType,
        sharp,
      });

      if (outcome.status === "generated") {
        finishDiagnostics({ status: "generated" });
        return outcome.value;
      }

      finishDiagnostics(outcome);
      return null;
    } catch {
      finishDiagnostics({ code: "decode_failed", status: "failed" });
      return null;
    }
  };

const createBlurHashField = (options: ResolvedOptions, lifecycleHook: FieldHook) =>
  ({
    access: {
      create: denyCallerWrite,
      update: denyCallerWrite,
    },
    admin: {
      ...(options.enabled ? {} : { hidden: true }),
      readOnly: true,
    },
    hooks: { beforeChange: [lifecycleHook] },
    localized: false,
    name: options.fieldName,
    required: false,
    type: "text",
    virtual: false,
  }) satisfies TextField;

const addBlurHashField = (
  collection: CollectionConfig,
  options: ResolvedOptions,
  lifecycleHook: FieldHook,
): CollectionConfig => ({
  ...collection,
  fields: [...collection.fields, createBlurHashField(options, lifecycleHook)],
});

export const blurHashPlugin = (options: BlurHashPluginOptions): Plugin => {
  const plugin: Plugin = (config) => {
    const { options: resolvedOptions, problems } = findConfigurationProblems(config, options);

    if (problems.length > 0) {
      throw new BlurHashPluginConfigError(problems);
    }

    const configuredCollections = new Set(resolvedOptions.collections);
    const generator =
      resolvedOptions.enabled && config.sharp
        ? createBlurHashGenerator({
            alphaBackground: resolvedOptions.alphaBackground,
            limits: resolvedOptions.limits,
          })
        : undefined;
    const runtime: GenerationRuntime = {
      diagnostics: createGenerationDiagnostics(resolvedOptions.debug),
      enabled: resolvedOptions.enabled,
      generator,
      sharp: config.sharp,
    };

    return {
      ...config,
      collections: (config.collections ?? []).map((collection) =>
        configuredCollections.has(collection.slug)
          ? addBlurHashField(
              collection,
              resolvedOptions,
              createBlurHashLifecycleHook(runtime, collection.slug),
            )
          : collection,
      ),
    };
  };

  plugin.slug = PLUGIN_SLUG;
  return plugin;
};
