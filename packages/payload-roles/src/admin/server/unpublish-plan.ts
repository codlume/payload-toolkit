import type { ResourceId, Subject } from "../../contract.ts";
import { can } from "../../grants.ts";

/**
 * `slot` is what the replaced `UnpublishButton` slot renders, `control` whether the plugin's
 * `beforeDocumentControls` control renders. A member never sees stock, so at most one Unpublish
 * exists per document.
 */
export type UnpublishPlan = { slot: "stock" | "none"; control: boolean };

export const planUnpublish = ({
  enabled,
  subject,
  resource,
}: {
  enabled: boolean;
  subject: Subject;
  resource: ResourceId;
}): UnpublishPlan =>
  !enabled || subject.kind === "outsider"
    ? { slot: "stock", control: false }
    : { slot: "none", control: can(subject.capabilities, resource, "unpublish") };
