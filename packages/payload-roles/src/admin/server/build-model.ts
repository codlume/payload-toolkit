import type { JSONFieldServerProps, PayloadRequest } from "payload";
import { formatAdminURL } from "payload/shared";

import {
  ACTION_IDS,
  type ActionId,
  type Capabilities,
  enforcerOf,
  type Grants,
  type Registry,
  type ResolvedOptions,
  type ResourceId,
} from "../../contract.ts";
import {
  can,
  checkPermissions,
  describeCellIssue,
  grantId,
  missingFrom,
  NO_CAPABILITIES,
  parsePermissions,
} from "../../grants.ts";
import type {
  Assignment,
  CellMode,
  CopySource,
  MatrixLock,
  MatrixModel,
  MatrixRow,
} from "../model.ts";

type PermissionsFieldInput = Pick<
  JSONFieldServerProps,
  "id" | "path" | "readOnly" | "req" | "value"
>;

const ACTION_LABELS: Record<ActionId, string> = {
  read: "Read",
  create: "Create",
  update: "Update",
  delete: "Delete",
  trash: "Trash",
  publish: "Publish",
  unpublish: "Unpublish",
  readVersions: "Versions",
  unlock: "Unlock",
};

const ALL: Capabilities = { kind: "all" };

export type ModelInput = {
  registry: Registry;
  options: Pick<ResolvedOptions, "enabled" | "rolesSlug" | "userCollection">;
  labels: ReadonlyMap<ResourceId, string>;
  editor: Capabilities;
  readOnly: boolean;
  existing: boolean;
  path: string;
  value: unknown;
  copySources: readonly CopySource[];
  assignment: Assignment | null;
};

const lockOf = (input: ModelInput, granted: Grants): MatrixLock | null => {
  if (input.readOnly) {
    return { kind: "read-only" };
  }
  const missing = input.options.enabled && input.existing ? missingFrom(granted, input.editor) : [];
  return missing.length > 0 ? { kind: "not-covered", missing } : null;
};

export const matrixModelOf = (input: ModelInput): MatrixModel => {
  const { registry, options, value } = input;
  const effective = options.enabled ? input.editor : ALL;
  const parsed = checkPermissions(value, registry, ALL);
  const lock = lockOf(input, parsed.grants);
  const modeOf = (id: ResourceId, action: ActionId): CellMode => {
    const holds =
      can(effective, id, action) && (action !== "publish" || can(effective, id, "update"));
    return lock === null && holds ? "grantable" : "fixed";
  };
  const rows = [...registry.values()].map((resource): MatrixRow => {
    const kind = resource.kind === "collection" ? "collections" : "globals";
    return {
      id: resource.id,
      kind,
      slug: resource.slug,
      label: input.labels.get(resource.id) ?? resource.slug,
      path: `${input.path}.${kind}.${resource.slug}.actions`,
      cells: Object.fromEntries(
        [...resource.actions].map((action) => [action, modeOf(resource.id, action)]),
      ),
    };
  });
  const users = registry.get(`collections:${options.userCollection}`);
  return {
    rows,
    columns: ACTION_IDS.filter((action) =>
      [...registry.values()].some((resource) => resource.actions.has(action)),
    ).map((action) => ({ action, label: ACTION_LABELS[action] })),
    stored: {
      fingerprint: JSON.stringify(value ?? null),
      granted: [...parsed.grants],
      issues: parsed.issues.map((issue) => ({
        row: issue.resource !== null && registry.has(issue.resource) ? issue.resource : null,
        message: describeCellIssue(issue),
      })),
    },
    lock,
    enforced: options.enabled,
    copySources: input.copySources,
    assignment: input.assignment,
    pickerCheck: users
      ? {
          assigns: [grantId(users.id, "update"), grantId(users.id, "create")],
          needs: grantId(`collections:${options.rolesSlug}`, "read"),
        }
      : null,
  };
};

const labelText = (label: unknown, req: PayloadRequest): string | undefined => {
  if (typeof label === "string") {
    return label;
  }
  if (typeof label === "function") {
    try {
      const text: unknown = label({ i18n: req.i18n, t: req.i18n.t });
      return typeof text === "string" ? text : undefined;
    } catch {
      return undefined;
    }
  }
  if (typeof label === "object" && label !== null) {
    const text: unknown = Reflect.get(label, req.i18n.language);
    return typeof text === "string" ? text : undefined;
  }
  return undefined;
};

const labelsOf = (req: PayloadRequest): Map<ResourceId, string> => {
  const labels = new Map<ResourceId, string>();
  const { collections, globals } = req.payload.config;
  for (const collection of collections) {
    const text = labelText(collection.labels.plural, req);
    if (text) {
      labels.set(`collections:${collection.slug}`, text);
    }
  }
  for (const global of globals) {
    const text = labelText(global.label, req);
    if (text) {
      labels.set(`globals:${global.slug}`, text);
    }
  }
  return labels;
};

const readableRoles = async (
  req: PayloadRequest,
  registry: Registry,
  options: ResolvedOptions,
  ownId: number | string | undefined,
): Promise<CopySource[]> => {
  try {
    const { docs } = await req.payload.find({
      collection: options.rolesSlug,
      depth: 0,
      overrideAccess: false,
      pagination: false,
      req,
      select: { name: true, [options.permissionsField]: true },
      ...(ownId !== undefined && { where: { id: { not_equals: ownId } } }),
    });
    return docs.flatMap((doc): CopySource[] => {
      if (!(options.permissionsField in doc)) {
        return [];
      }
      const name: unknown = doc.name;
      return [
        {
          id: String(doc.id),
          name: typeof name === "string" && name !== "" ? name : String(doc.id),
          granted: [...parsePermissions(doc[options.permissionsField], registry).grants],
        },
      ];
    });
  } catch {
    return [];
  }
};

const assignmentOf = async (
  req: PayloadRequest,
  options: ResolvedOptions,
  id: number | string,
): Promise<Assignment | null> => {
  try {
    const { totalDocs } = await req.payload.count({
      collection: options.userCollection,
      overrideAccess: false,
      req,
      where: { [options.rolesField]: { in: [id] } },
    });
    return {
      count: totalDocs,
      href: formatAdminURL({
        adminRoute: req.payload.config.routes.admin,
        path: `/collections/${options.userCollection}?where[or][0][and][0][${options.rolesField}][in][0]=${encodeURIComponent(String(id))}`,
      }),
    };
  } catch {
    return null;
  }
};

/** Resolves the editor from `req`, never from the read-filtered `user` prop. */
export const loadMatrixModel = async ({
  id,
  path,
  readOnly,
  req,
  value,
}: PermissionsFieldInput): Promise<MatrixModel> => {
  const { options, registry, subject } = enforcerOf(req.payload);
  const viewer = await subject(req);
  const editor = viewer.kind === "member" ? viewer.capabilities : NO_CAPABILITIES;
  const effective = options.enabled ? editor : ALL;
  const users = registry.get(`collections:${options.userCollection}`);
  const readsUsers = !users || can(effective, users.id, "read");
  const [copySources, assignment] = await Promise.all([
    readableRoles(req, registry, options, id),
    id !== undefined && readsUsers ? assignmentOf(req, options, id) : null,
  ]);
  return matrixModelOf({
    registry,
    options,
    labels: labelsOf(req),
    editor,
    readOnly: readOnly === true,
    existing: id !== undefined,
    path,
    value,
    copySources,
    assignment,
  });
};
