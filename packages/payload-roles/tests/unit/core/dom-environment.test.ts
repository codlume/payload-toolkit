// @vitest-environment jsdom
// The DOM facility admin tests use: a per-file jsdom environment and React's own createRoot.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test } from "vitest";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  document.body.replaceChildren();
});

test("a component renders into jsdom and reacts to a click", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let clicks = 0;
  await act(async () => {
    root.render(
      createElement(
        "button",
        {
          onClick: () => {
            clicks += 1;
          },
          type: "button",
        },
        "Grant",
      ),
    );
  });
  const button = container.querySelector("button");
  await act(async () => {
    button?.click();
  });
  expect({ clicks, label: button?.textContent }).toEqual({ clicks: 1, label: "Grant" });
  await act(async () => {
    root.unmount();
  });
});
