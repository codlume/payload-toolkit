import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import manifest from "../../../../apps/payload-cms/tests/fixtures/images/manifest.json" with { type: "json" };
import { inspectImageInput } from "../../src/inspect-image-input.ts";

const fixtureDirectory = new URL(
  "../../../../apps/payload-cms/tests/fixtures/images/",
  import.meta.url,
);

describe("inspectImageInput", () => {
  test.each(manifest.fixtures)("classifies $name as $expected", async (fixture) => {
    const input = await readFile(new URL(fixture.name, fixtureDirectory));
    const inspection = inspectImageInput(input, fixture.mime);
    const expected =
      fixture.expected === "eligible"
        ? { format: fixture.mime === "image/png" ? "png" : "jpeg", status: "eligible" }
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

  test("settles declared and detected type disagreement as a failure", async () => {
    const input = await readFile(new URL("png-opaque.png", fixtureDirectory));

    expect(inspectImageInput(input, "image/jpeg")).toEqual({
      code: "type_mismatch",
      status: "failed",
    });
  });
});
