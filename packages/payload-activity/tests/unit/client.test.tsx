// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { LastModifiedByField } from "@codlume/payload-activity/client";

const payloadUIState = vi.hoisted(
  (): {
    apiState: {
      data: Record<string, unknown>;
      isError: boolean;
      isLoading: boolean;
    };
    documentData: Record<string, unknown>;
    useAsTitle: string;
    usePayloadAPI: ReturnType<typeof vi.fn>;
    value: null | number | string;
  } => ({
    apiState: {
      data: {},
      isError: false,
      isLoading: false,
    },
    documentData: { updatedAt: "2026-08-20T12:34:56.000Z" },
    useAsTitle: "name",
    usePayloadAPI: vi.fn(),
    value: 42,
  }),
);

vi.mock("@payloadcms/ui", () => ({
  FieldLabel: ({ label }: { label: string }) => <div>{label}</div>,
  useConfig: () => ({
    config: {
      admin: { user: "users" },
      routes: { admin: "/admin", api: "/api" },
      serverURL: "https://cms.example.test",
    },
    getEntityConfig: () => ({ admin: { useAsTitle: payloadUIState.useAsTitle } }),
  }),
  useDocumentInfo: () => ({ data: payloadUIState.documentData }),
  useField: () => ({ value: payloadUIState.value }),
  usePayloadAPI: payloadUIState.usePayloadAPI,
}));

const renderField = () =>
  render(
    <LastModifiedByField
      field={{ name: "lastModifiedBy", relationTo: "users" }}
      path="lastModifiedBy"
    />,
  );

beforeEach(() => {
  payloadUIState.apiState = {
    data: { email: "ada@example.test", name: "Ada Lovelace" },
    isError: false,
    isLoading: false,
  };
  payloadUIState.documentData = { updatedAt: "2026-08-20T12:34:56.000Z" };
  payloadUIState.useAsTitle = "name";
  payloadUIState.usePayloadAPI.mockClear();
  payloadUIState.usePayloadAPI.mockImplementation(() => [
    payloadUIState.apiState,
    { setParams: vi.fn() },
  ]);
  payloadUIState.value = 42;
  vi.spyOn(Date.prototype, "toLocaleString").mockReturnValue("Aug 20, 2026, 2:34 PM");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

test("attributed edit links the configured user title beside the local update time", () => {
  renderField();

  expect({
    fetch: payloadUIState.usePayloadAPI.mock.calls,
    label: screen.getByText("Last Modified By").textContent,
    link: {
      href: screen.getByRole("link", { name: "Ada Lovelace" }).getAttribute("href"),
      text: screen.getByRole("link", { name: "Ada Lovelace" }).textContent,
    },
    timestamp: screen.getByText("Aug 20, 2026, 2:34 PM").textContent,
  }).toEqual({
    fetch: [["https://cms.example.test/api/users/42", { initialParams: { depth: 0 } }]],
    label: "Last Modified By",
    link: {
      href: "https://cms.example.test/admin/collections/users/42",
      text: "Ada Lovelace",
    },
    timestamp: "Aug 20, 2026, 2:34 PM",
  });
});

test("attributed edit falls back to the user's email", () => {
  payloadUIState.apiState.data = { email: "ada@example.test" };

  renderField();

  expect(screen.getByRole("link", { name: "ada@example.test" }).getAttribute("href")).toBe(
    "https://cms.example.test/admin/collections/users/42",
  );
});

test("unattributed edit renders a dash without requesting a user", () => {
  payloadUIState.value = null;

  const { container } = renderField();

  expect({
    fetchCount: payloadUIState.usePayloadAPI.mock.calls.length,
    links: container.querySelectorAll("a").length,
    state: screen.getByText("—").textContent,
    timestamps: container.querySelectorAll("time").length,
  }).toEqual({
    fetchCount: 0,
    links: 0,
    state: "—",
    timestamps: 0,
  });
});

test("in-flight user request shows only the timestamp and no spinner", () => {
  payloadUIState.apiState = { data: {}, isError: false, isLoading: true };

  const { container } = renderField();

  expect({
    fetchCount: payloadUIState.usePayloadAPI.mock.calls.length,
    links: container.querySelectorAll("a").length,
    spinner: screen.queryByRole("progressbar"),
    timestamp: screen.getByText("Aug 20, 2026, 2:34 PM").textContent,
  }).toEqual({
    fetchCount: 1,
    links: 0,
    spinner: null,
    timestamp: "Aug 20, 2026, 2:34 PM",
  });
});

test("changing the attributed user starts a fresh request without showing the prior user", () => {
  payloadUIState.apiState.data = { email: "ada@example.test", name: "Ada Lovelace" };
  payloadUIState.usePayloadAPI.mockImplementation(function usePayloadAPI(url: string) {
    const [state] = React.useState(() =>
      url.endsWith("/42") ? payloadUIState.apiState : { data: {}, isError: false, isLoading: true },
    );

    return [state, { setParams: vi.fn() }];
  });
  const { rerender } = renderField();

  expect(screen.getByRole("link", { name: "Ada Lovelace" })).toBeTruthy();

  payloadUIState.value = 84;
  rerender(
    <LastModifiedByField
      field={{ name: "lastModifiedBy", relationTo: "users" }}
      path="lastModifiedBy"
    />,
  );

  expect({
    priorUser: screen.queryByRole("link", { name: "Ada Lovelace" }),
    rawID: screen.queryByRole("link", { name: "84" }),
    timestamp: screen.getByText("Aug 20, 2026, 2:34 PM").textContent,
  }).toEqual({
    priorUser: null,
    rawID: null,
    timestamp: "Aug 20, 2026, 2:34 PM",
  });
});

test.each([
  ["failed request", { data: { name: "Stale name" }, isError: true, isLoading: false }],
  ["deleted user", { data: {}, isError: true, isLoading: false }],
])("%s falls back to the raw user ID", (_state, apiState) => {
  payloadUIState.apiState = apiState;

  renderField();

  expect(screen.getByRole("link", { name: "42" }).textContent).toBe("42");
});

test("absolute local timestamp remains stable across rerenders", () => {
  const { container, rerender } = renderField();

  rerender(
    <LastModifiedByField
      field={{ name: "lastModifiedBy", relationTo: "users" }}
      path="lastModifiedBy"
    />,
  );

  const timestamp = container.querySelector("time");

  expect({
    dateTime: timestamp?.getAttribute("datetime"),
    liveRegions: container.querySelectorAll("[aria-live]").length,
    text: timestamp?.textContent,
  }).toEqual({
    dateTime: "2026-08-20T12:34:56.000Z",
    liveRegions: 0,
    text: "Aug 20, 2026, 2:34 PM",
  });
});
