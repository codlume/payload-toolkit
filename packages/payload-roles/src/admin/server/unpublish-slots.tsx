import type { Payload, ServerProps } from "payload";
import React from "react";

import { enforcerOf, type Resource, type ResourceId } from "../../contract.ts";
import { planUnpublish } from "./unpublish-plan.ts";
import { subjectOfViewer } from "./viewer.ts";

export type UnpublishSlotProps = ServerProps & { resource: ResourceId };

const SLOT_PATH = "@codlume/payload-roles#UnpublishSlot";

/** False when the app configured its own `UnpublishButton`, which then owns Unpublish. */
const ownsUnpublish = (payload: Payload, { kind, slug }: Resource) => {
  const slot: unknown =
    kind === "collection"
      ? payload.collections[slug]?.config.admin.components?.edit?.UnpublishButton
      : payload.config.globals.find((global) => global.slug === slug)?.admin.components?.elements
          ?.UnpublishButton;
  const path = typeof slot === "object" && slot !== null && "path" in slot ? slot.path : slot;
  return path === SLOT_PATH;
};

const planOf = async ({ payload, user, resource }: UnpublishSlotProps) => {
  const enforcer = enforcerOf(payload);
  const governed = enforcer.options.enabled && enforcer.registry.has(resource);
  const subject = governed
    ? await subjectOfViewer(enforcer, payload, user)
    : { kind: "outsider" as const };
  return planUnpublish({ enabled: governed, subject, resource });
};

// Client modules load through dynamic imports: a static import of `@payloadcms/ui` or the
// client entry pulls `.css` into the server entry, which plain Node cannot import.

/** Replaces Payload's `UnpublishButton` slot, which renders only for viewers with save permission. */
export const UnpublishSlot = async (props: UnpublishSlotProps) => {
  if ((await planOf(props)).slot === "none") {
    return null;
  }
  const { UnpublishButton } = await import("@payloadcms/ui");
  return <UnpublishButton />;
};

/** Rendered in `beforeDocumentControls`, which Payload shows on read-only forms too. */
export const UnpublishControl = async (props: UnpublishSlotProps) => {
  const managed = enforcerOf(props.payload).registry.get(props.resource);
  if (!managed || !ownsUnpublish(props.payload, managed) || !(await planOf(props)).control) {
    return null;
  }
  const { UnpublishDocument } = await import("@codlume/payload-roles/client");
  return <UnpublishDocument />;
};
