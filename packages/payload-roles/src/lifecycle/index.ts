// Seeded by core. Owned by the lifecycle thread from here on.
//
// Interim rule: a write is allowed only when the editor holds every action it could possibly
// need, so publish, unpublish, trash and readVersions never grant a write on their own. The
// lifecycle thread replaces this with hooks that classify the actual transition.
import type { ActionId, LifecycleModule, WriteAccessArgs } from "../contract.ts";

const STATUS = "_status";

const isStatusOnly = (data: WriteAccessArgs["data"]) =>
  data !== undefined && Object.keys(data).every((key) => key === STATUS);

const requiredWriteActions = ({ resource, key, data }: WriteAccessArgs): ReadonlySet<ActionId> => {
  const required = new Set<ActionId>([key]);
  if (key === "create") {
    if (resource.drafts && data?.[STATUS] !== "draft") {
      required.add("publish");
    }
    return required;
  }
  if (resource.drafts) {
    required.add("publish");
    required.add("unpublish");
  }
  if (resource.trash && data !== undefined && "deletedAt" in data) {
    required.add("trash");
  }
  if (resource.versions && isStatusOnly(data)) {
    required.add("readVersions");
  }
  return required;
};

export const lifecycle: LifecycleModule = {
  enforcing: false,
  requiredWriteActions,
  collectionHooks: () => ({}),
  globalHooks: () => ({}),
};
