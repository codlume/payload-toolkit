// The permissions matrix wire contract: built on the server, serialized through RSC props, read by
// the client. Types only, so both sides can import it without sharing runtime code.

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

/** An action missing from `MatrixRow.cells` does not apply to that resource: a blank cell. */
export type CellMode = "grantable" | "fixed";

export type StorageKind = "collections" | "globals";

export type MatrixRow = {
  id: ResourceId;
  kind: StorageKind;
  slug: string;
  label: string;
  /** The form path core's errors use for this row: `<field>.<kind>.<slug>.actions`. */
  path: string;
  cells: Partial<Record<ActionId, CellMode>>;
};

/** ACTION_IDS order, restricted to actions that apply to at least one row. */
export type MatrixColumn = { action: ActionId; label: string };

export type Note = { row: ResourceId | null; message: string };

/** The server's reading of the value it rendered with, on page load or reset. */
export type StoredReading = {
  /** `JSON.stringify(value ?? null)`. */
  fingerprint: string;
  /** What `parsePermissions` grants, the only cells a value the client cannot decode may show. */
  granted: readonly Grant[];
  /** Shape issues and publish without update, which the next write drops. */
  issues: readonly Note[];
};

export type MatrixLock =
  | { kind: "read-only" }
  /** The role grants cells the editor lacks, so core refuses any update to it. */
  | { kind: "not-covered"; missing: readonly Grant[] };

export type CopySource = { id: string; name: string; granted: readonly Grant[] };

export type Assignment = { count: number; href: string };

/** Holders of any `assigns` cell edit users, but the Roles picker lists nothing without `needs`. */
export type PickerCheck = { assigns: readonly Grant[]; needs: Grant };

export type MatrixModel = {
  rows: readonly MatrixRow[];
  columns: readonly MatrixColumn[];
  stored: StoredReading;
  /** Why every cell is fixed. */
  lock: MatrixLock | null;
  /** False when the plugin is disabled: nothing is enforced and every applicable cell is grantable. */
  enforced: boolean;
  copySources: readonly CopySource[];
  /** Null on create and when the editor cannot read users. */
  assignment: Assignment | null;
  /** Null when the user collection is not managed. */
  pickerCheck: PickerCheck | null;
};
