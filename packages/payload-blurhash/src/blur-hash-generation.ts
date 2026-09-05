import { readFile, stat } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import { encode } from "blurhash";
import type { FieldHook, PayloadLogger, SharpDependency } from "payload";

import { inspectImageInput } from "./inspect-image-input.ts";

const MAX_PREVIEW_EDGE = 32;
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1_000);
const COMPONENTS_X = 4;
const COMPONENTS_Y = 3;
const DECODE_FAILED = { code: "decode_failed", status: "failed" } as const;
const DECODE_TIMEOUT = { code: "decode_timeout", status: "failed" } as const;
const MAX_MIME_TYPE_LENGTH = 128;
const PLUGIN_NAME = "blurhash";

type GenerationOutcome =
  | { code: "animated_input" | "not_eligible"; status: "skipped" }
  | {
      code:
        | "decode_failed"
        | "decode_timeout"
        | "decoder_unavailable"
        | "encode_failed"
        | "input_too_large"
        | "malformed_container"
        | "type_mismatch";
      status: "failed";
    }
  | { status: "generated"; value: string };

type GenerationInput = {
  input: Buffer;
  mimeType: unknown;
  sharp: SharpDependency;
};

type PendingGeneration = {
  active: boolean;
  cancelTimeout: () => void;
  generation: GenerationInput;
  resolve: (outcome: GenerationOutcome) => void;
  settled: boolean;
};

type DiagnosticOutcome =
  | Exclude<GenerationOutcome, { status: "generated" }>
  | {
      status: "generated";
    };

type DiagnosticStage = "decode" | "encode" | "inspect" | "limits" | "queue";

type DiagnosticContext = {
  collection: string;
  height: unknown;
  inputBytes: number;
  logger: PayloadLogger;
  mimeType: unknown;
  width: unknown;
};

type BlurHashGenerationOptions = {
  alphaBackground: { b: number; g: number; r: number };
  debug: boolean;
  enabled: boolean;
  limits: {
    concurrency: number;
    maxInputBytes: number;
    maxInputPixels: number;
    maxInputSide: number;
    timeoutSeconds: number;
  };
  sharp: SharpDependency | undefined;
};

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isDecoderUnavailable = (sharp: SharpDependency, format: string) => {
  const formats: unknown = Reflect.get(sharp, "format");

  if (!isRecord(formats)) {
    return false;
  }

  const formatInfo = formats[format];
  const input = isRecord(formatInfo) ? formatInfo.input : undefined;

  return !isRecord(input) || input.buffer !== true;
};

const scheduleTimeout = (seconds: number, onTimeout: () => void) => {
  let remainingSeconds = seconds;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const scheduleNext = () => {
    const delaySeconds = Math.min(remainingSeconds, MAX_TIMER_SECONDS);
    remainingSeconds -= delaySeconds;
    timer = setTimeout(() => {
      if (remainingSeconds === 0) {
        onTimeout();
      } else {
        scheduleNext();
      }
    }, delaySeconds * 1_000);
  };

  scheduleNext();
  return () => clearTimeout(timer);
};

const settleGeneration = (item: PendingGeneration, outcome: GenerationOutcome) => {
  if (item.settled) {
    return;
  }

  item.settled = true;
  item.cancelTimeout();
  item.resolve(outcome);
};

const createGenerator = ({
  alphaBackground,
  limits,
}: Pick<BlurHashGenerationOptions, "alphaBackground" | "limits">) => {
  const generate = async ({
    input,
    mimeType,
    sharp,
  }: GenerationInput): Promise<GenerationOutcome> => {
    if (input.length > limits.maxInputBytes) {
      return { code: "input_too_large", status: "failed" };
    }

    const inspection = inspectImageInput(input, mimeType);

    if (inspection.status !== "eligible") {
      return inspection;
    }

    const metadataFormat = inspection.format === "avif" ? "heif" : inspection.format;

    if (isDecoderUnavailable(sharp, metadataFormat)) {
      return { code: "decoder_unavailable", status: "failed" };
    }

    let metadata;

    try {
      metadata = await sharp(input, { animated: true, failOn: "warning" }).metadata();
    } catch {
      return { code: "decode_failed", status: "failed" };
    }

    if (
      metadata.format !== metadataFormat ||
      (inspection.format === "avif" && metadata.mediaType !== "image/avif")
    ) {
      return { code: "type_mismatch", status: "failed" };
    }

    if (metadata.pages !== undefined && metadata.pages !== 1) {
      return { code: "animated_input", status: "skipped" };
    }

    const { height, width } = metadata;

    if (
      !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(width) ||
      Number(height) < 1 ||
      Number(width) < 1
    ) {
      return { code: "decode_failed", status: "failed" };
    }

    if (
      Number(height) > limits.maxInputSide ||
      Number(width) > limits.maxInputSide ||
      Number(width) > Math.floor(limits.maxInputPixels / Number(height))
    ) {
      return { code: "input_too_large", status: "failed" };
    }

    const normalized = await (async () => {
      try {
        return await sharp(input, { failOn: "warning" })
          .rotate()
          .toColorspace("srgb")
          .flatten({ background: alphaBackground })
          .resize({
            fit: "inside",
            height: MAX_PREVIEW_EDGE,
            width: MAX_PREVIEW_EDGE,
            withoutEnlargement: true,
          })
          .ensureAlpha()
          .raw({ depth: "uchar" })
          .toBuffer({ resolveWithObject: true });
      } catch {
        return undefined;
      }
    })();

    if (!normalized) {
      return { code: "decode_failed", status: "failed" };
    }

    const { data: pixels, info } = normalized;

    if (info.channels !== 4 || info.width < 1 || info.height < 1) {
      return { code: "decode_failed", status: "failed" };
    }

    try {
      return {
        status: "generated",
        value: encode(
          new Uint8ClampedArray(pixels),
          info.width,
          info.height,
          COMPONENTS_X,
          COMPONENTS_Y,
        ),
      };
    } catch {
      return { code: "encode_failed", status: "failed" };
    }
  };

  const pending: PendingGeneration[] = [];
  let active = 0;

  const startPending = () => {
    while (active < limits.concurrency) {
      const item = pending.shift();

      if (!item) {
        return;
      }

      if (item.settled) {
        continue;
      }

      item.active = true;
      active += 1;
      const work = Promise.resolve().then(() => generate(item.generation));
      const finish = () => {
        active -= 1;
        startPending();
      };

      void work.then(
        (outcome) => settleGeneration(item, outcome),
        () => settleGeneration(item, DECODE_FAILED),
      );
      void work.then(finish, finish);
    }
  };

  return (generation: GenerationInput) =>
    new Promise<GenerationOutcome>((resolve) => {
      const item: PendingGeneration = {
        active: false,
        cancelTimeout: () => undefined,
        generation,
        resolve,
        settled: false,
      };
      item.cancelTimeout = scheduleTimeout(limits.timeoutSeconds, () => {
        settleGeneration(item, DECODE_TIMEOUT);

        if (!item.active) {
          const index = pending.indexOf(item);

          if (index >= 0) {
            pending.splice(index, 1);
          }
        }
      });
      pending.push(item);
      startPending();
    });
};

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

const createDiagnostics = (debug: boolean) => {
  const unavailableDecoders = new Set<string>();

  return ({
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
  };
};

const isFileRemoval = (data: Record<string, unknown> | undefined) => data?.filename === null;

const readEffectiveUpload = async (
  file: NonNullable<Parameters<FieldHook>[0]["req"]["file"]>,
  maxInputBytes: number,
) => {
  if (!file.tempFilePath) {
    return { input: file.data, inputBytes: file.data.length } as const;
  }

  try {
    const fileStats = await stat(file.tempFilePath);

    if (fileStats.size > maxInputBytes) {
      return { code: "input_too_large", inputBytes: fileStats.size } as const;
    }

    const input = await readFile(file.tempFilePath);
    return { input, inputBytes: input.length } as const;
  } catch {
    return { code: "decode_failed", inputBytes: file.size } as const;
  }
};

export const createBlurHashGeneration = ({
  alphaBackground,
  debug,
  enabled,
  limits,
  sharp: configuredSharp,
}: BlurHashGenerationOptions) => {
  const startDiagnostics = createDiagnostics(debug);
  const generate =
    enabled && configuredSharp ? createGenerator({ alphaBackground, limits }) : undefined;

  return (collectionSlug: string): FieldHook =>
    async (args) => {
      if (isFileRemoval(args.data)) {
        return null;
      }

      if (!args.req.file) {
        return args.previousValue ?? null;
      }

      const sharp = args.req.payload.config.sharp ?? configuredSharp;

      if (!enabled || !generate || !sharp) {
        return null;
      }

      const effectiveUpload = await readEffectiveUpload(args.req.file, limits.maxInputBytes);
      const finishDiagnostics = startDiagnostics({
        collection: collectionSlug,
        height: args.data?.height,
        inputBytes: effectiveUpload.inputBytes,
        logger: args.req.payload.logger,
        mimeType: args.data?.mimeType,
        width: args.data?.width,
      });

      if ("code" in effectiveUpload) {
        finishDiagnostics({ code: effectiveUpload.code, status: "failed" });
        return null;
      }

      try {
        const outcome = await generate({
          input: effectiveUpload.input,
          mimeType: args.data?.mimeType,
          sharp,
        });

        if (outcome.status === "generated") {
          finishDiagnostics({ status: "generated" });
          return outcome.value;
        }

        finishDiagnostics(outcome);
        return null;
      } catch {
        finishDiagnostics({ code: "decode_failed", status: "failed" });
        return null;
      }
    };
};
