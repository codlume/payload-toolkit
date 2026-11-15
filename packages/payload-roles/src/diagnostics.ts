import type { Payload } from "payload";

import type { Diagnostics } from "./contract.ts";

type Level = "debug" | "error" | "warn";

const emit = (
  level: Level,
  payload: Payload,
  event: string,
  fields: Record<string, unknown> | undefined,
) => {
  try {
    payload.logger[level]({ plugin: "roles", event, ...fields });
  } catch {
    return;
  }
};

const silent = () => {};

export const createRolesDiagnostics = (debug: boolean): Diagnostics => ({
  debug: debug ? (payload, event, fields) => emit("debug", payload, event, fields) : silent,
  warn: (payload, event, fields) => emit("warn", payload, event, fields),
  error: (payload, event, fields) => emit("error", payload, event, fields),
});
