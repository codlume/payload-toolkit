import type { JSONFieldServerProps } from "payload";
import React from "react";

import { loadMatrixModel } from "./build-model.ts";

// Declared from Payload's types alone: a declaration path from here to model.ts would make both
// entries' declarations share it, which splits it into a fifth dist file.
export type PermissionsFieldProps = Pick<
  JSONFieldServerProps,
  "clientField" | "id" | "path" | "readOnly" | "req" | "value"
>;

/** The roles `permissions` field. Registered as `@codlume/payload-roles#PermissionsField`. */
export const PermissionsField = async (props: PermissionsFieldProps) => {
  // A static import would load @payloadcms/ui, and its CSS imports, whenever the root entry loads in Node.
  const { PermissionsMatrix } = await import("@codlume/payload-roles/client");
  return (
    <PermissionsMatrix
      field={props.clientField}
      model={await loadMatrixModel(props)}
      path={props.path}
    />
  );
};
