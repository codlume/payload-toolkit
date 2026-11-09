import { describe, expect, test } from "vitest";

import { createOperationScope, type OperationTarget } from "../../../src/scope.ts";

const page = (id: OperationTarget["id"]): OperationTarget => ({
  collection: "pages",
  kind: "update",
  id,
});

const request = {};

const nestedTrustedInside = (outerId: OperationTarget["id"], document: OperationTarget["id"]) => {
  const scope = createOperationScope<string>();
  scope.open(page(outerId), request, false, "outer");
  scope.open(page(document), request, true, "nested");
  return scope.lookup(page(document), request);
};

describe.each(["05", "+5", " 5", "5 ", "5.0", "5.", "5e0", ".5e1", "005.00"])(
  "an untrusted write naming row 5 as %j",
  (spelling) => {
    test("is judged with a trusted nested write on row 5", () => {
      expect(nestedTrustedInside(spelling, 5)).toEqual({
        all: ["nested", "outer"],
        innermost: "nested",
        trusted: false,
      });
    });
  },
);

describe.each([
  "A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11",
  "{a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11}",
  "a0eebc999c0b4ef8bb6d6bb9bd380a11",
])("an untrusted write naming a uuid as %j", (spelling) => {
  test("is judged with a trusted nested write on the canonical uuid", () => {
    expect(nestedTrustedInside(spelling, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).toMatchObject({
      all: ["nested", "outer"],
      trusted: false,
    });
  });
});

test("an untrusted write on another document lowers trust but is not judged on this one", () => {
  expect(nestedTrustedInside(7, 5)).toEqual({
    all: ["nested"],
    innermost: "nested",
    trusted: false,
  });
});

test("records opened for another request are ignored", () => {
  const scope = createOperationScope<string>();
  scope.open(page(5), {}, false, "other request");
  scope.open(page(5), request, true, "own");
  expect(scope.lookup(page(5), request)).toEqual({
    all: ["own"],
    innermost: "own",
    trusted: true,
  });
});

test("no record covering the document means no verdict, which callers treat as untrusted", () => {
  const scope = createOperationScope<string>();
  scope.open({ collection: "posts", kind: "update", id: 5 }, request, true, "posts");
  expect(scope.lookup(page(5), request)).toBeUndefined();
});

test("a chain deeper than the cap is never trusted", () => {
  const scope = createOperationScope<number>();
  for (let index = 0; index < 70; index += 1) {
    scope.open(page(index), request, true, index);
  }
  expect(scope.lookup(page(69), request)).toMatchObject({ trusted: false });
});

describe.each(["", " ", "\t", "\n"])("an untrusted write naming row 0 as %j", (spelling) => {
  test("is judged with a trusted nested write on row 0", () => {
    expect(nestedTrustedInside(spelling, 0)).toMatchObject({
      all: ["nested", "outer"],
      trusted: false,
    });
  });
});

test("settle moves an entry to the document Payload acts on", () => {
  const scope = createOperationScope<string>();
  const settle = scope.open(page("alias:home"), request, false, "outer");
  scope.open(page(5), request, true, "nested");
  expect(scope.lookup(page(5), request)?.all).toEqual(["nested"]);
  settle(5);
  expect(scope.lookup(page(5), request)).toMatchObject({
    all: ["nested", "outer"],
    trusted: false,
  });
});

test("widen makes unsettled entries of the collection name every document", () => {
  const scope = createOperationScope<string>();
  scope.open(page("alias:home"), request, false, "outer");
  scope.open(page(5), request, true, "nested");
  scope.widen("pages", "update", request);
  expect(scope.lookup(page(5), request)).toMatchObject({
    all: ["nested", "outer"],
    trusted: false,
  });
});

test("widen leaves settled entries and other requests alone", () => {
  const scope = createOperationScope<string>();
  scope.open(page(7), {}, false, "other request");
  const settle = scope.open(page(7), request, false, "settled");
  settle(7);
  scope.open(page(5), request, true, "nested");
  scope.widen("pages", "update", request);
  expect(scope.lookup(page(5), request)?.all).toEqual(["nested"]);
});
