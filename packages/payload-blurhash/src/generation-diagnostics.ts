import { performance } from "node:perf_hooks";

import type { PayloadLogger } from "payload";

import type { GenerationOutcome } from "./generate-blur-hash.ts";

type DiagnosticOutcome =
  | Exclude<GenerationOutcome, { status: "generated" }>
  | { status: "generated" };

type DiagnosticStage = "decode" | "encode" | "inspect" | "limits" | "queue";

type DiagnosticContext = {
  collection: string;
  height: unknown;
  inputBytes: number;
  logger: PayloadLogger;
  mimeType: unknown;
  width: unknown;
};

const MAX_MIME_TYPE_LENGTH = 128;
const PLUGIN_NAME = "blurhash";
const CODE_STAGES = {
  animated_input: "inspect",
  decode_failed: "decode",
  decode_timeout: "decode",
  decoder_unavailable: "decode",
  encode_failed: "encode",
  input_too_large: "limits",
  malformed_container: "inspect",
  not_eligible: "inspect",
  type_mismatch: "inspect",
} as const satisfies Record<
  Exclude<DiagnosticOutcome, { status: "generated" }>["code"],
  DiagnosticStage
>;

const boundMimeType = (value: unknown) => {
  if (typeof value !== "string") {
    return undefined;
  }

  const mimeType = value.trim().toLowerCase();
  return mimeType.length === 0 ? undefined : mimeType.slice(0, MAX_MIME_TYPE_LENGTH);
};

const readDimension = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : undefined;

const readDuration = (startedAt: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.round(performance.now() - startedAt)));

const emit = (
  logger: PayloadLogger,
  level: "debug" | "warn",
  entry: Record<string, number | string>,
) => {
  try {
    logger[level](entry);
  } catch {
    return;
  }
};

export const createGenerationDiagnostics = (debug: boolean) => {
  const unavailableDecoders = new Set<string>();

  return {
    start: ({
      collection,
      height: heightValue,
      inputBytes,
      logger,
      mimeType: mimeTypeValue,
      width: widthValue,
    }: DiagnosticContext) => {
      const startedAt = performance.now();
      const height = readDimension(heightValue);
      const mimeType = boundMimeType(mimeTypeValue);
      const width = readDimension(widthValue);
      const context = {
        collection,
        ...(height === undefined ? {} : { height }),
        inputBytes,
        ...(mimeType === undefined ? {} : { mimeType }),
        plugin: PLUGIN_NAME,
        ...(width === undefined ? {} : { width }),
      };

      if (debug) {
        emit(logger, "debug", {
          ...context,
          event: "generation_started",
          stage: "queue",
        });
      }

      return (outcome: DiagnosticOutcome) => {
        const durationMs = readDuration(startedAt);

        if (outcome.status === "generated") {
          if (debug) {
            emit(logger, "debug", {
              ...context,
              durationMs,
              event: "generation_generated",
              stage: "encode",
            });
          }

          return;
        }

        const entry = {
          ...context,
          code: outcome.code,
          durationMs,
          event: outcome.status === "skipped" ? "generation_skipped" : "generation_failed",
          stage: CODE_STAGES[outcome.code],
        };

        if (outcome.status === "skipped") {
          if (debug) {
            emit(logger, "debug", entry);
          }

          return;
        }

        if (outcome.code === "decoder_unavailable") {
          const decoder = mimeType ?? "unknown";

          if (unavailableDecoders.has(decoder)) {
            return;
          }

          unavailableDecoders.add(decoder);
        }

        emit(logger, "warn", entry);
      };
    },
  };
};
