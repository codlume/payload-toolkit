import { createRequire } from "node:module";

import React, { type ReactNode } from "react";
import { beforeEach, expect, test, vi } from "vitest";

import { UnpublishDocument } from "../../../src/admin/client/unpublish-document.tsx";

const { renderToStaticMarkup }: { renderToStaticMarkup: (node: ReactNode) => string } =
  createRequire(import.meta.url)("react-dom/server");

type Confirm = () => Promise<void> | void;

const ui = vi.hoisted(() => {
  const state: { info: Record<string, unknown>; confirm: Confirm | null } = {
    info: {},
    confirm: null,
  };
  return Object.assign(state, {
    request: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
    reset: vi.fn(async (_data: unknown) => {}),
    toast: { error: vi.fn(), success: vi.fn() },
  });
});

vi.mock("@payloadcms/ui", () => ({
  Button: ({ children, type }: { children: ReactNode; type: "button" | "submit" }) => (
    <button type={type}>{children}</button>
  ),
  ConfirmationModal: ({ onConfirm }: { onConfirm: Confirm }) => {
    ui.confirm = onConfirm;
    return null;
  },
  toast: ui.toast,
  useConfig: () => ({ config: { routes: { api: "/api" }, serverURL: "" } }),
  useDocumentInfo: () => ui.info,
  useForm: () => ({ reset: ui.reset }),
  useModal: () => ({ toggleModal: () => {} }),
  useTranslation: () => ({ i18n: { language: "en" }, t: (key: string) => key }),
}));

vi.mock("@payloadcms/ui/shared", () => ({
  requests: { patch: ui.request, post: ui.request },
}));

const setters = {
  setHasPublishedDoc: vi.fn(),
  setMostRecentVersionIsAutosaved: vi.fn(),
  setUnpublishedVersionCount: vi.fn(),
};

const published = (overrides: Record<string, unknown> = {}) => {
  ui.info = {
    collectionSlug: "pages",
    data: { title: "Hello", _status: "published" },
    hasPublishedDoc: true,
    id: 7,
    isTrashed: false,
    ...setters,
    ...overrides,
  };
  ui.confirm = null;
  return renderToStaticMarkup(<UnpublishDocument />);
};

const confirm = async () => {
  if (!ui.confirm) {
    throw new Error("no confirmation modal rendered");
  }
  await ui.confirm();
};

beforeEach(() => {
  vi.clearAllMocks();
});

test("a published document offers a plain button that works on a read-only form", () => {
  expect(published()).toBe('<button type="button">version:unpublish</button>');
  expect(published({ collectionSlug: undefined, globalSlug: "settings", id: undefined })).toBe(
    '<button type="button">version:unpublish</button>',
  );
});

test("an unpublished, trashed or unsaved document offers nothing", () => {
  expect(published({ hasPublishedDoc: false })).toBe("");
  expect(published({ isTrashed: true })).toBe("");
  expect(published({ id: undefined })).toBe("");
});

test("a 200 sends the stock request, resets to draft and flips the published state", async () => {
  published();
  ui.request.mockResolvedValue(new Response("{}", { status: 200 }));
  await confirm();

  expect(ui.request).toHaveBeenCalledWith(
    "/api/pages/7?depth=0&fallback-locale=null&unpublishAllLocales=true",
    {
      body: '{"_status":"draft"}',
      headers: { "Accept-Language": "en", "Content-Type": "application/json" },
    },
  );
  expect(ui.reset).toHaveBeenCalledWith({ title: "Hello", _status: "draft" });
  expect(ui.toast.success).toHaveBeenCalledWith("version:unpublishedSuccessfully");
  expect(ui.toast.error).not.toHaveBeenCalled();
  expect(setters.setUnpublishedVersionCount).toHaveBeenCalledWith(1);
  expect(setters.setMostRecentVersionIsAutosaved).toHaveBeenCalledWith(false);
  expect(setters.setHasPublishedDoc).toHaveBeenCalledWith(false);
});

test("a refused request shows the server's message and changes nothing", async () => {
  published();
  ui.request.mockResolvedValue(
    Response.json({ errors: [{ message: "You are not allowed." }] }, { status: 403 }),
  );
  await confirm();

  expect(ui.toast.error).toHaveBeenCalledWith("You are not allowed.");
  expect(ui.toast.success).not.toHaveBeenCalled();
  expect(ui.reset).not.toHaveBeenCalled();
  expect(setters.setHasPublishedDoc).not.toHaveBeenCalled();
});

test("a body without a message or a network failure shows the generic error", async () => {
  published();
  ui.request.mockResolvedValue(new Response("not json", { status: 500 }));
  await confirm();
  ui.request.mockRejectedValue(new TypeError("Failed to fetch"));
  await confirm();

  expect(ui.toast.error.mock.calls).toEqual([
    ["error:unPublishingDocument"],
    ["error:unPublishingDocument"],
  ]);
  expect(ui.toast.success).not.toHaveBeenCalled();
  expect(setters.setHasPublishedDoc).not.toHaveBeenCalled();
});
