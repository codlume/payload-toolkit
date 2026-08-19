import { expect, test, vi } from "vitest";

import * as clientEntry from "@codlume/payload-activity/client";

vi.mock("@payloadcms/ui", () => ({
  FieldLabel: vi.fn(),
  useConfig: vi.fn(),
  useDocumentInfo: vi.fn(),
  useField: vi.fn(),
  usePayloadAPI: vi.fn(),
}));

test("client entry exposes only the last-modified-by field", () => {
  expect(Object.keys(clientEntry)).toEqual(["LastModifiedByField"]);
});
