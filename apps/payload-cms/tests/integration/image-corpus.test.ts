import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, test } from "vitest";

import manifest from "../fixtures/images/manifest.json" with { type: "json" };
import { readImageFixture } from "./image-fixtures.ts";

describe("image fixture corpus", () => {
  test("records its original provenance, license, and fixed generator versions", () => {
    expect({
      generator: manifest.generatedBy,
      license: manifest.corpusLicense,
      provenance: manifest.provenance,
    }).toEqual({
      generator: {
        generator: "tests/fixtures/images/generate.mjs@1",
        libvips: "8.18.3",
        node: "v24.13.1",
        sharp: "0.35.3",
      },
      license: "MIT",
      provenance:
        "Procedurally generated for Payload Toolkit from original pixel patterns; no third-party image source was used.",
    });
  });

  test("includes the dedicated fixture license", async () => {
    const license = await readFile(
      new URL("../fixtures/images/LICENSE.md", import.meta.url),
      "utf8",
    );

    expect(license).toContain("MIT License");
  });

  test.each(manifest.fixtures)("$name matches its recorded bytes and checksum", async (fixture) => {
    const bytes = await readImageFixture(fixture.name);

    expect({
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    }).toEqual({ bytes: fixture.bytes, sha256: fixture.sha256 });
  });
});
