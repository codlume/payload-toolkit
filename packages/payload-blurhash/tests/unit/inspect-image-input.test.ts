import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import manifest from "../../../../apps/payload-cms/tests/fixtures/images/manifest.json" with { type: "json" };
import { inspectImageInput } from "../../src/inspect-image-input.ts";

const fixtureDirectory = new URL(
  "../../../../apps/payload-cms/tests/fixtures/images/",
  import.meta.url,
);

const formatFromMime = (mime: string) => {
  if (mime === "image/avif") return "avif";
  if (mime === "image/jpeg") return "jpeg";
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";

  throw new TypeError(`Fixture has unsupported MIME ${mime}`);
};

describe("inspectImageInput", () => {
  test.each(manifest.fixtures)("classifies $name as $expected", async (fixture) => {
    const input = await readFile(new URL(fixture.name, fixtureDirectory));
    const inspection = inspectImageInput(input, fixture.mime);
    const expected =
      fixture.expected === "eligible"
        ? { format: formatFromMime(fixture.mime), status: "eligible" }
        : {
            code: fixture.expected,
            status: fixture.expected === "animated_input" ? "skipped" : "failed",
          };

    expect(inspection).toEqual(expected);
  });

  test("settles unsupported MIME as an expected skip", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));

    expect(inspectImageInput(input, "image/jpg")).toEqual({
      code: "not_eligible",
      status: "skipped",
    });
  });

  test.each([
    ["jpeg-baseline.jpg", " IMAGE/JPEG ; charset=binary", "jpeg"],
    ["png-opaque.png", " IMAGE/PNG ; charset=binary", "png"],
    ["webp-lossy.webp", " IMAGE/WEBP ; charset=binary", "webp"],
    ["avif-8-bit.avif", " IMAGE/AVIF ; charset=binary", "avif"],
  ])("normalizes the declared MIME for %s", async (fixture, mime, format) => {
    const input = await readFile(new URL(fixture, fixtureDirectory));

    expect(inspectImageInput(input, mime)).toEqual({ format, status: "eligible" });
  });

  test("normalization still rejects disagreement between MIME and content", async () => {
    const input = await readFile(new URL("jpeg-baseline.jpg", fixtureDirectory));

    expect(inspectImageInput(input, " IMAGE/PNG ; charset=binary")).toEqual({
      code: "type_mismatch",
      status: "failed",
    });
  });

  test.each([
    ["png-opaque.png", "image/jpeg"],
    ["webp-lossy.webp", "image/avif"],
    ["avif-8-bit.avif", "image/webp"],
  ])("settles %s declared as %s as a type disagreement", async (fixture, mime) => {
    const input = await readFile(new URL(fixture, fixtureDirectory));

    expect(inspectImageInput(input, mime)).toEqual({
      code: "type_mismatch",
      status: "failed",
    });
  });
});
