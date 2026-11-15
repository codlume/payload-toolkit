import { expect, test } from "vitest";

import { composeAccess } from "../../../src/access.ts";

test("composeAccess follows the intersection table", () => {
  const where = { title: { equals: "x" } };
  expect(composeAccess(false, true)).toBe(false);
  expect(composeAccess(true, false)).toBe(false);
  expect(composeAccess(true, true)).toBe(true);
  expect(composeAccess(true, where)).toBe(where);
  expect(composeAccess(where, true)).toBe(where);
  expect(composeAccess(where, false)).toBe(false);
  expect(composeAccess(where, { id: { equals: 1 } })).toEqual({
    and: [where, { id: { equals: 1 } }],
  });
});

test("composeAccess treats an app result that is not true or a Where as a denial", () => {
  const where = { title: { equals: "x" } };
  expect(composeAccess(where, undefined)).toBe(false);
  expect(composeAccess(where, null)).toBe(false);
  expect(composeAccess(true, undefined)).toBe(false);
});
