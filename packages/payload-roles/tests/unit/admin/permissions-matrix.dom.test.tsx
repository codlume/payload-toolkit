// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import { PermissionsMatrix } from "../../../src/admin/client/permissions-matrix.tsx";
import type { MatrixModel, ResourceId } from "../../../src/admin/model.ts";
import { holding, modelOf } from "./fixture.ts";

type Harness = {
  initial: unknown;
  errorMessage: string | undefined;
  showError: boolean;
  sent: unknown[];
  formTouches: number;
};

const harness = vi.hoisted(
  (): Harness => ({
    initial: undefined,
    errorMessage: undefined,
    showError: false,
    sent: [],
    formTouches: 0,
  }),
);

// The @payloadcms/ui root imports CSS, which jsdom cannot load. useField keeps real React state.
vi.mock("@payloadcms/ui", async () => {
  const { useState } = await import("react");
  return {
    FieldDescription: () => null,
    FieldLabel: () => null,
    useField: () => {
      const [value, setState] = useState<unknown>(harness.initial);
      return {
        errorMessage: harness.errorMessage,
        setValue: (next: unknown) => {
          harness.sent.push(next);
          setState(next);
        },
        showError: harness.showError,
        value,
      };
    },
    useForm: () => {
      harness.formTouches += 1;
      return {};
    },
    useFormFields: () => {
      harness.formTouches += 1;
    },
  };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const labels = new Map<ResourceId, string>([
  ["collections:pages", "Pages"],
  ["collections:posts", "Posts"],
  ["collections:roles", "Roles"],
  ["collections:users", "Users"],
  ["globals:settings", "Settings"],
]);

let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
  harness.initial = undefined;
  harness.errorMessage = undefined;
  harness.showError = false;
  harness.sent = [];
  harness.formTouches = 0;
});

const mount = async (model: MatrixModel, value: unknown = {}) => {
  harness.initial = value;
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <PermissionsMatrix
        field={{ name: "permissions", type: "json" }}
        model={model}
        path="permissions"
      />,
    );
  });
};

const box = (label: string) => {
  const found = container.querySelector(`input[aria-label="${label}"]`);
  if (!(found instanceof HTMLInputElement)) {
    throw new Error(`no checkbox ${label}`);
  }
  return found;
};

const button = (name: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.getAttribute("aria-label") === name || candidate.textContent === name,
  );
  if (!found) {
    throw new Error(`no button ${name}`);
  }
  return found;
};

const click = (element: HTMLElement) =>
  act(async () => {
    element.click();
  });

const field = <Element extends HTMLInputElement | HTMLSelectElement>(
  selector: string,
  kind: new () => Element,
) => {
  const found = container.querySelector(selector);
  if (!(found instanceof kind)) {
    throw new Error(`no ${selector}`);
  }
  return found;
};

// React tracks a controlled value through the prototype setter, so a plain assignment would
// not reach onChange.
const type = (element: HTMLInputElement | HTMLSelectElement, value: string, event: string) =>
  act(async () => {
    const prototype: unknown = Object.getPrototypeOf(element);
    const descriptor =
      typeof prototype === "object" && prototype !== null
        ? Object.getOwnPropertyDescriptor(prototype, "value")
        : undefined;
    descriptor?.set?.call(element, value);
    element.dispatchEvent(new Event(event, { bubbles: true }));
  });

const lastSent = () => harness.sent.at(-1);

describe("checkbox wiring", () => {
  test("a cell click writes the canonical value and checks the box", async () => {
    await mount(modelOf({ labels }));
    await click(box("Pages: Read"));
    expect(lastSent()).toEqual({ collections: { pages: { actions: ["read"] } }, globals: {} });
    expect(box("Pages: Read").checked).toBe(true);
  });

  test("checking Publish also checks Update, and unchecking Update clears Publish", async () => {
    await mount(modelOf({ labels }));
    await click(box("Pages: Publish"));
    expect(lastSent()).toEqual({
      collections: { pages: { actions: ["update", "publish"] } },
      globals: {},
    });
    expect([box("Pages: Update").checked, box("Pages: Publish").checked]).toEqual([true, true]);
    await click(box("Pages: Update"));
    expect(lastSent()).toEqual({ collections: {}, globals: {} });
    expect([box("Pages: Update").checked, box("Pages: Publish").checked]).toEqual([false, false]);
  });

  test("a cell the editor cannot grant is disabled and ignores clicks", async () => {
    await mount(modelOf({ editor: holding("collections:pages#read"), labels }));
    expect(box("Pages: Delete").disabled).toBe(true);
    await click(box("Pages: Delete"));
    expect(harness.sent).toEqual([]);
    expect(box("Pages: Delete").checked).toBe(false);
  });

  test("the row toggle grants every cell the editor can and leaves the rest", async () => {
    await mount(
      modelOf({
        editor: holding(
          "collections:pages#read",
          "collections:pages#update",
          "collections:pages#publish",
        ),
        labels,
      }),
    );
    await click(button("All Pages permissions"));
    expect(lastSent()).toEqual({
      collections: { pages: { actions: ["read", "update", "publish"] } },
      globals: {},
    });
    await click(button("Clear Pages permissions"));
    expect(lastSent()).toEqual({ collections: {}, globals: {} });
  });

  test("a column toggle acts only on the rows the filter shows", async () => {
    await mount(modelOf({ labels }));
    await type(field('input[type="search"]', HTMLInputElement), "sett", "input");
    expect(
      [...container.querySelectorAll('tbody th[scope="row"]')].map((th) => th.textContent),
    ).toEqual(["Settings"]);
    await click(button("All Read on shown resources"));
    expect(lastSent()).toEqual({ collections: {}, globals: { settings: { actions: ["read"] } } });
  });

  test("Copy from role takes the source's grantable cells and reports the cells it kept", async () => {
    await mount(
      modelOf({
        copySources: [
          {
            id: "7",
            name: "Publisher",
            granted: [
              "collections:pages#read",
              "collections:pages#update",
              "collections:pages#publish",
              "globals:settings#read",
            ],
          },
        ],
        editor: holding(
          "collections:pages#read",
          "collections:pages#update",
          "globals:settings#read",
        ),
        labels,
      }),
    );
    await type(field("select", HTMLSelectElement), "7", "change");
    await click(button("Copy"));
    expect(lastSent()).toEqual({
      collections: { pages: { actions: ["read", "update"] } },
      globals: { settings: { actions: ["read"] } },
    });
    expect(container.textContent).toContain("Copied from Publisher.");
    expect(container.textContent).toContain("Pages: Publish");
  });
});

describe("stored and server-reported problems", () => {
  test("a malformed stored value shows only parsed grants until Remove invalid entries rewrites it", async () => {
    const stored = {
      collections: {
        ghost: { actions: ["read"] },
        pages: { actions: ["read", "bogus"] },
        posts: { actions: "read" },
      },
    };
    await mount(modelOf({ labels, value: stored }), stored);
    expect([box("Pages: Read").checked, box("Posts: Read").checked]).toEqual([true, false]);
    expect(harness.sent).toEqual([]);
    await click(button("Remove invalid entries"));
    expect(lastSent()).toEqual({ collections: { pages: { actions: ["read"] } }, globals: {} });
  });

  test("a refused save's message lands on its rows, and the matrix never edits form state or the value", async () => {
    const value = { collections: { pages: { actions: ["read"] } }, globals: {} };
    const snapshot = structuredClone(value);
    harness.showError = true;
    harness.errorMessage = [
      'permissions.collections.pages.actions: You cannot grant action "delete" on "collections:pages" because you do not hold it.',
      'permissions.collections.ghost.actions: "collections:ghost" is not managed by the roles plugin.',
    ].join("\n");
    await mount(modelOf({ labels, value }), value);

    const pagesRow = box("Pages: Read").closest("tr");
    expect(pagesRow?.querySelector('[role="alert"]')?.textContent).toBe(
      'You cannot grant action "delete" on "collections:pages" because you do not hold it.',
    );
    expect(container.querySelector('ul[role="alert"]')?.textContent).toBe(
      'permissions.collections.ghost.actions: "collections:ghost" is not managed by the roles plugin.',
    );
    expect(box("Pages: Read").checked).toBe(true);

    await click(box("Pages: Update"));
    expect(lastSent()).toEqual({
      collections: { pages: { actions: ["read", "update"] } },
      globals: {},
    });
    expect(value).toEqual(snapshot);
    expect(harness.formTouches).toBe(0);
  });
});
