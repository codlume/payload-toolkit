import type { SharpDependency } from "payload";
import hostSharp from "sharp";

export const createConcurrencySharp = (recordActive: (active: number) => void): SharpDependency => {
  let active = 0;

  return ((input, options) => {
    const pipeline = hostSharp(input, options);

    if (options?.animated) {
      Object.defineProperty(pipeline, "metadata", {
        value: async () => {
          active += 1;
          recordActive(active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return { format: "jpeg", height: 24, pages: 1, width: 40 };
        },
      });
    }

    return pipeline;
  }) satisfies SharpDependency;
};

export const createHangingSharp = (): SharpDependency =>
  ((input, options) => {
    const pipeline = hostSharp(input, options);
    Object.defineProperty(pipeline, "metadata", {
      value: () => new Promise(() => undefined),
    });
    return pipeline;
  }) satisfies SharpDependency;
