import { expect, test, vi } from "vitest";

import * as clientEntry from "@codlume/payload-blurhash/client";

vi.mock("@payloadcms/ui", () => ({
  useField: vi.fn(),
}));

test("client entry exposes only the preview component at runtime", () => {
  expect(Object.keys(clientEntry)).toEqual(["BlurHashPreview"]);
});
