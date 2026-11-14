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

test("settle makes an entry answer to the request an app hook swapped in, and to the old one", () => {
  const scope = createOperationScope<string>();
  const swapped = {};
  const settle = scope.open(page(5), request, false, "own");
  expect(scope.lookup(page(5), swapped)).toBeUndefined();
  settle(5, { req: swapped, trusted: true });
  expect(scope.lookup(page(5), swapped)).toEqual({
    all: ["own"],
    innermost: "own",
    trusted: false,
  });
  expect(scope.lookup(page(5), request)).toEqual({
    all: ["own"],
    innermost: "own",
    trusted: false,
  });
});

describe.each([
  { expected: true, swappedIs: "trusted", trusted: true },
  { expected: false, swappedIs: "untrusted", trusted: false },
])("a trusted entry moved to a request that is $swappedIs", ({ expected, trusted }) => {
  test(`is ${expected ? "still" : "no longer"} trusted under either request`, () => {
    const scope = createOperationScope<string>();
    const swapped = {};
    const settle = scope.open(page(5), request, true, "own");
    settle(5, { req: swapped, trusted });
    expect(scope.lookup(page(5), swapped)?.trusted).toBe(expected);
    expect(scope.lookup(page(5), request)?.trusted).toBe(expected);
  });
});

test("rekey moves unsettled entries of the collection and kind, and leaves the others", () => {
  const scope = createOperationScope<string>();
  const swapped = {};
  scope.open({ collection: "posts", kind: "update", id: 5 }, request, false, "posts");
  scope.open(page(5), {}, false, "other request");
  scope.open(page(5), request, true, "unsettled");
  const settle = scope.open(page(5), request, false, "settled");
  settle(5);
  scope.rekey("pages", "update", request, { req: swapped, trusted: false });
  expect(scope.lookup(page(5), swapped)).toEqual({
    all: ["unsettled"],
    innermost: "unsettled",
    trusted: false,
  });
  expect(scope.lookup(page(5), request)?.all).toEqual(["settled", "unsettled"]);
});

test("widen makes unsettled entries of the collection name every document", () => {
  const scope = createOperationScope<string>();
  scope.open(page("alias:home"), request, false, "outer");
  scope.open(page(5), request, true, "nested");
  scope.widen("pages", "update", request, 5);
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
  scope.widen("pages", "update", request, 5);
  expect(scope.lookup(page(5), request)?.all).toEqual(["nested"]);
});

test("settle never narrows an entry opened without an id", () => {
  const scope = createOperationScope<string>();
  const settle = scope.open(page(undefined), request, false, "bulk");
  scope.open(page(5), request, true, "nested");
  settle(7);
  expect(scope.lookup(page(5), request)).toMatchObject({ all: ["nested", "bulk"], trusted: false });
});

test("widen leaves entries that already name the final document", () => {
  const scope = createOperationScope<string>();
  scope.open(page(5), request, false, "own");
  scope.open(page(9), request, true, "nested elsewhere");
  scope.widen("pages", "update", request, 5);
  expect(scope.lookup(page(9), request)?.all).toEqual(["nested elsewhere"]);
});

test("widen never settles an entry narrowly, so a later widen can still widen it", () => {
  const scope = createOperationScope<string>();
  scope.open(page(5), request, false, "own");
  scope.widen("pages", "update", request, 5);
  scope.open(page(9), request, true, "nested elsewhere");
  scope.widen("pages", "update", request, 9);
  expect(scope.lookup(page(9), request)).toEqual({
    all: ["nested elsewhere", "own"],
    innermost: "nested elsewhere",
    trusted: false,
  });
});

test("a trusted write covers its own document under any spelling of its id", () => {
  const scope = createOperationScope<string>();
  scope.open(page("7e0"), request, true, "trusted");
  expect(scope.lookup(page(7), request)).toEqual({
    all: ["trusted"],
    innermost: "trusted",
    trusted: true,
  });
  expect(scope.lookup(page(8), request)).toBeUndefined();
});
