import { expect, test } from "vitest";

import { unpublishErrorOf, unpublishTarget } from "../../../src/admin/client/unpublish-request.ts";

const QUERY = "?depth=0&fallback-locale=null&unpublishAllLocales=true";

test("a collection doc is unpublished by PATCH to its id", () => {
  expect(unpublishTarget({ api: "/api", serverURL: "", collectionSlug: "pages", id: 7 })).toEqual({
    method: "patch",
    url: `/api/pages/7${QUERY}`,
  });
  expect(
    unpublishTarget({
      api: "/api",
      serverURL: "https://cms.example.com",
      collectionSlug: "pages",
      id: "a/b c",
    }),
  ).toEqual({ method: "patch", url: `https://cms.example.com/api/pages/a%2Fb%20c${QUERY}` });
});

test("a global is unpublished by POST to its globals route", () => {
  expect(unpublishTarget({ api: "/api", serverURL: "", globalSlug: "settings" })).toEqual({
    method: "post",
    url: `/api/globals/settings${QUERY}`,
  });
  expect(
    unpublishTarget({
      api: "/cms-api",
      serverURL: "https://cms.example.com",
      globalSlug: "settings",
    }),
  ).toEqual({ method: "post", url: `https://cms.example.com/cms-api/globals/settings${QUERY}` });
});

test("an unsaved collection doc or a missing slug has no target", () => {
  expect(unpublishTarget({ api: "/api", serverURL: "", collectionSlug: "pages" })).toBeNull();
  expect(unpublishTarget({ api: "/api", serverURL: "" })).toBeNull();
});

test("the error message follows Payload's stock precedence", () => {
  expect(unpublishErrorOf({ errors: [{ message: "first" }], error: "second" })).toBe("first");
  expect(unpublishErrorOf({ errors: [{ message: "" }], error: "second" })).toBe("second");
  expect(unpublishErrorOf({ errors: [], error: "second" })).toBe("second");
  expect(unpublishErrorOf({ errors: [{}] })).toBeNull();
  expect(unpublishErrorOf({ error: 403 })).toBeNull();
  expect(unpublishErrorOf(null)).toBeNull();
  expect(unpublishErrorOf("Forbidden")).toBeNull();
});
