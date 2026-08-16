import type { SharpDependency } from "payload";

import { encodeBlurHash } from "./encode-blur-hash.ts";
import { inspectImageInput } from "./inspect-image-input.ts";

const MAX_PREVIEW_EDGE = 32;
const MAX_TIMER_SECONDS = Math.floor(2_147_483_647 / 1_000);
const DECODE_FAILED = { code: "decode_failed", status: "failed" } as const;
const DECODE_TIMEOUT = { code: "decode_timeout", status: "failed" } as const;

type GenerateBlurHashOptions = {
  alphaBackground: { b: number; g: number; r: number };
};

type BlurHashGeneratorOptions = GenerateBlurHashOptions & {
  limits: {
    concurrency: number;
    maxInputBytes: number;
    maxInputPixels: number;
    maxInputSide: number;
    timeoutSeconds: number;
  };
};

type GenerationInput = {
  input: Buffer;
  mimeType: unknown;
  sharp: SharpDependency;
};

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

type PendingGeneration = {
  active: boolean;
  cancelTimeout: () => void;
  generation: GenerationInput;
  resolve: (outcome: GenerationOutcome) => void;
  settled: boolean;
};

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

export const createBlurHashGenerator = ({ alphaBackground, limits }: BlurHashGeneratorOptions) => {
  const generate = async ({
    input,
    mimeType,
    sharp,
  }: GenerationInput): Promise<GenerationOutcome> => {
    if (input.length > limits.maxInputBytes) {
      return { code: "input_too_large" as const, status: "failed" as const };
    }

    const inspection = inspectImageInput(input, mimeType);

    if (inspection.status !== "eligible") {
      return inspection;
    }

    const metadataFormat = inspection.format === "avif" ? "heif" : inspection.format;

    if (isDecoderUnavailable(sharp, metadataFormat)) {
      return { code: "decoder_unavailable" as const, status: "failed" as const };
    }

    let metadata;

    try {
      metadata = await sharp(input, { animated: true, failOn: "warning" }).metadata();
    } catch {
      return { code: "decode_failed" as const, status: "failed" as const };
    }

    if (
      metadata.format !== metadataFormat ||
      (inspection.format === "avif" && metadata.mediaType !== "image/avif")
    ) {
      return { code: "type_mismatch" as const, status: "failed" as const };
    }

    if (metadata.pages !== undefined && metadata.pages !== 1) {
      return { code: "animated_input" as const, status: "skipped" as const };
    }

    const { height, width } = metadata;

    if (
      !Number.isSafeInteger(height) ||
      !Number.isSafeInteger(width) ||
      Number(height) < 1 ||
      Number(width) < 1
    ) {
      return { code: "decode_failed" as const, status: "failed" as const };
    }

    if (
      Number(height) > limits.maxInputSide ||
      Number(width) > limits.maxInputSide ||
      Number(width) > Math.floor(limits.maxInputPixels / Number(height))
    ) {
      return { code: "input_too_large" as const, status: "failed" as const };
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
      return { code: "decode_failed" as const, status: "failed" as const };
    }

    const { data: pixels, info } = normalized;

    if (info.channels !== 4 || info.width < 1 || info.height < 1) {
      return { code: "decode_failed" as const, status: "failed" as const };
    }

    try {
      return {
        status: "generated" as const,
        value: encodeBlurHash(new Uint8ClampedArray(pixels), info.width, info.height),
      };
    } catch {
      return { code: "encode_failed" as const, status: "failed" as const };
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

  return {
    generate: (generation: GenerationInput) =>
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
      }),
  };
};
