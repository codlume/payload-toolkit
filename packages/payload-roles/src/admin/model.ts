// Types only, so both sides can import it without sharing runtime code.

// Restated from contract.ts because the client entry's declarations reach this file, and a type
// both entries' declarations share splits into a fifth dist file. tests/unit/admin/build-model.test.ts
// pins them to the contract.
export type ActionId =
  | "read"
  | "create"
  | "update"
  | "delete"
  | "trash"
  | "publish"
  | "unpublish"
  | "readVersions"
  | "unlock";

export type ResourceId = `collections:${string}` | `globals:${string}`;

export type Grant = `${ResourceId}#${ActionId}`;

export type CellMode = "grantable" | "fixed";

export type StorageKind = "collections" | "globals";

export type MatrixRow = {
  id: ResourceId;
  kind: StorageKind;
  slug: string;
  label: string;
  path: string;
  cells: Partial<Record<ActionId, CellMode>>;
};

export type MatrixColumn = { action: ActionId; label: string };

export type Note = { row: ResourceId | null; message: string };

export type StoredReading = {
  fingerprint: string;
  granted: readonly Grant[];
  issues: readonly Note[];
};

export type MatrixLock = { kind: "read-only" } | { kind: "not-covered"; missing: readonly Grant[] };

export type CopySource = { id: string; name: string; granted: readonly Grant[] };

export type Assignment = { count: number; href: string };

export type PickerCheck = { assigns: readonly Grant[]; needs: Grant };

export type MatrixModel = {
  rows: readonly MatrixRow[];
  columns: readonly MatrixColumn[];
  stored: StoredReading;
  lock: MatrixLock | null;
  enforced: boolean;
  copySources: readonly CopySource[];
  assignment: Assignment | null;
  pickerCheck: PickerCheck | null;
};
