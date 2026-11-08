import type { ResourceId, Subject } from "../../contract.ts";
import { can } from "../../grants.ts";

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
