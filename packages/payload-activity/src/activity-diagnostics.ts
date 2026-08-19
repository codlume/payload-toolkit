import type { PayloadRequest } from "payload";

type AttributionDiagnostic = {
  collection: null | { slug: string };
  global: null | { slug: string };
  operation: "create" | "update" | undefined;
  req: PayloadRequest;
} & (
  | {
      event: "attribution_applied";
      userId: number | string;
    }
  | {
      event: "attribution_cleared";
      reason: "foreign_auth_collection" | "no_user";
    }
);

export const createActivityDiagnostics =
  (debug: boolean) => (diagnostic: AttributionDiagnostic) => {
    if (!debug) {
      return;
    }

    const { collection, event, global, operation, req } = diagnostic;
    const target = collection ?? global;

    if (!target) {
      return;
    }

    try {
      req.payload.logger.debug({
        entityType: collection ? "collection" : "global",
        event,
        operation,
        plugin: "activity",
        ...(diagnostic.event === "attribution_applied"
          ? { userId: diagnostic.userId }
          : { reason: diagnostic.reason }),
        slug: target.slug,
      });
    } catch {
      return;
    }
  };
