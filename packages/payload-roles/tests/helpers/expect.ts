import { expect } from "vitest";

/** Asserts a rejected Local API call by Payload error name, the type callers branch on. */
export const rejectsWith = async (
  promise: Promise<unknown>,
  name: "Forbidden" | "NotFound" | "ValidationError",
) => {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ${name}`).toBeInstanceOf(Error);
  expect(error).toMatchObject({ name });
};

/** Asserts a `ValidationError` and returns the field paths it names. */
export const validationPaths = async (promise: Promise<unknown>): Promise<string[]> => {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toMatchObject({ name: "ValidationError" });
  const data: unknown = error instanceof Error && "data" in error ? error.data : undefined;
  const errors: unknown =
    typeof data === "object" && data !== null && "errors" in data ? data.errors : undefined;
  expect(Array.isArray(errors)).toBe(true);
  return Array.isArray(errors)
    ? errors.flatMap((entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "path" in entry &&
        typeof entry.path === "string"
          ? [entry.path]
          : [],
      )
    : [];
};
