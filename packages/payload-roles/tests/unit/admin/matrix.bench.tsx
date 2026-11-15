// @vitest-environment jsdom
import { writeFileSync } from "node:fs";

// Run: pnpm --filter @codlume/payload-roles exec vitest bench tests/unit/admin/matrix.bench.tsx --run
// Prints model payload size and render counts, then timings for mounting and clicking the matrix.
import React, { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, bench, describe, vi } from "vitest";

import type { Capabilities, Grant } from "../../../src/contract.ts";
import { ACTION_IDS } from "../../../src/contract.ts";
import { grantsOf } from "../../../src/grants.ts";
import { buildRegistry } from "../../../src/registry.ts";
import { applyOp, readMatrix } from "../../../src/admin/client/matrix.ts";
import { PermissionsMatrix } from "../../../src/admin/client/permissions-matrix.tsx";
import type { MatrixModel } from "../../../src/admin/model.ts";
import { matrixModelOf } from "../../../src/admin/server/build-model.ts";

const harness = vi.hoisted((): { initial: unknown; renders: number; tableRows: number } => ({
  initial: undefined,
  renders: 0,
  tableRows: 0,
}));

// Counts <tr> elements created, so a click shows how many table rows React re-rendered.
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return {
    ...actual,
    jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
      if (args[0] === "tr") {
        harness.tableRows += 1;
      }
      return actual.jsxDEV(...args);
    },
  };
});

vi.mock("@payloadcms/ui", async () => {
  const { useState } = await import("react");
  return {
    FieldDescription: () => null,
    FieldLabel: () => null,
    useField: () => {
      harness.renders += 1;
      const [value, setValue] = useState<unknown>(harness.initial);
      return { errorMessage: undefined, setValue, showError: false, value };
    },
  };
});

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const COLLECTIONS = 80;
const GLOBALS = 20;
const ROLES = 50;

const large = buildRegistry(
  {
    collections: [
      { auth: true, slug: "users" },
      { slug: "roles", versions: true },
      ...Array.from({ length: COLLECTIONS - 2 }, (_, index) => ({
        slug: `collection-${index}`,
        trash: index % 2 === 0,
        versions: index % 3 === 0 ? { drafts: true } : index % 3 === 1,
      })),
    ],
    globals: Array.from({ length: GLOBALS }, (_, index) => ({
      slug: `global-${index}`,
      versions: index % 2 === 0 ? { drafts: true } : false,
    })),
  },
  {
    collections: [
      "users",
      ...Array.from({ length: COLLECTIONS - 2 }, (_, index) => `collection-${index}`),
    ],
    globals: Array.from({ length: GLOBALS }, (_, index) => `global-${index}`),
    rolesSlug: "roles",
  },
);

const small = buildRegistry(
  {
    collections: [
      { auth: true, slug: "users" },
      { slug: "pages", trash: true, versions: { drafts: true } },
      { slug: "posts" },
      { slug: "roles", versions: true },
    ],
    globals: [{ slug: "settings", versions: { drafts: true } }],
  },
  { collections: ["users", "pages", "posts"], globals: ["settings"], rolesSlug: "roles" },
);

const allCells = (registry: typeof large): Grant[] =>
  [...registry.values()].flatMap((resource) =>
    ACTION_IDS.filter((action) => resource.actions.has(action)).map(
      (action): Grant => `${resource.id}#${action}`,
    ),
  );

/** Deterministic pseudo-random subset so every run sees the same roles. */
const subset = (cells: readonly Grant[], seed: number) =>
  cells.filter((_, index) => ((index + 1) * 2_654_435_761 + seed * 40_503) % 7 < 3);

const editorOf = (cells: readonly Grant[]): Capabilities => ({
  kind: "grants",
  grants: grantsOf(subset(cells, 99)),
});

const stored = (cells: readonly Grant[]) => {
  const value: Record<string, Record<string, { actions: string[] }>> = {
    collections: {},
    globals: {},
  };
  for (const cell of cells) {
    const [resource = "", action = ""] = cell.split("#");
    const [kind = "", slug = ""] = resource.split(":");
    const entries = value[kind] ?? {};
    entries[slug] = { actions: [...(entries[slug]?.actions ?? []), action] };
    value[kind] = entries;
  }
  return value;
};

const modelFor = (registry: typeof large, roles: number) => {
  const cells = allCells(registry);
  const editor = editorOf(cells);
  const held = editor.kind === "grants" ? [...editor.grants] : [];
  const value = stored(subset(held, 7));
  return {
    value,
    model: matrixModelOf({
      registry,
      options: { enabled: true, rolesSlug: "roles", userCollection: "users" },
      labels: new Map([...registry.values()].map((resource) => [resource.id, resource.slug])),
      editor,
      readOnly: false,
      existing: true,
      path: "permissions",
      value,
      copySources: Array.from({ length: roles }, (_, index) => ({
        id: String(index + 1),
        name: `Role ${index + 1}`,
        granted: subset(cells, index),
      })),
      assignment: { count: 3, href: "/admin/collections/users?x=1" },
    }),
  };
};

const largeCase = modelFor(large, ROLES);
const smallCase = modelFor(small, 5);

let root: Root | undefined;
let container: HTMLDivElement;
let lastDuration = 0;

const mount = async ({ model, value }: { model: MatrixModel; value: unknown }) => {
  harness.initial = value;
  container = document.createElement("div");
  document.body.append(container);
  const created = createRoot(container);
  root = created;
  await act(async () => {
    created.render(
      <Profiler
        id="matrix"
        onRender={(_id, _phase, actualDuration) => {
          lastDuration += actualDuration;
        }}
      >
        <PermissionsMatrix
          field={{ name: "permissions", type: "json" }}
          model={model}
          path="permissions"
        />
      </Profiler>,
    );
  });
};

const unmount = async () => {
  await act(async () => {
    root?.unmount();
  });
  root = undefined;
  document.body.replaceChildren();
};

const grantableBoxes = () =>
  [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].filter(
    (input) => !input.disabled,
  );

const payloadOf = ({ model }: { model: MatrixModel }) => ({
  modelBytes: JSON.stringify(model).length,
  copySourcesBytes: JSON.stringify(model.copySources).length,
  rows: model.rows.length,
});

const median = (values: number[]) => values.toSorted((a, b) => a - b)[10] ?? 0;

/** React's dev build reports per-commit render time; the median of 21 clicks is the metric. */
const clickRenderMs = async () => {
  await mount(largeCase);
  const durations: number[] = [];
  const tableRows: number[] = [];
  const clickFrom = async (index: number): Promise<void> => {
    if (index === 21) {
      return;
    }
    lastDuration = 0;
    harness.tableRows = 0;
    await act(async () => {
      grantableBoxes()[index % 7]?.click();
    });
    durations.push(lastDuration);
    tableRows.push(harness.tableRows);
    await clickFrom(index + 1);
  };
  await clickFrom(0);
  const renders = harness.renders;
  await unmount();
  return { medianRenderMs: median(durations), tableRowsPerClick: median(tableRows), renders };
};

const metrics = {
  small: payloadOf(smallCase),
  large: payloadOf(largeCase),
  largeClick: await clickRenderMs(),
};
process.stdout.write(`[metrics] ${JSON.stringify(metrics)}\n`);
if (process.env.BENCH_METRICS) {
  writeFileSync(process.env.BENCH_METRICS, `${JSON.stringify(metrics, null, 2)}\n`);
}

describe("permissions matrix", () => {
  afterAll(unmount);

  bench("server: matrixModelOf (large)", () => {
    modelFor(large, ROLES);
  });

  bench("client: readMatrix (large)", () => {
    readMatrix(largeCase.model, largeCase.value);
  });

  bench("client: applyOp one cell (large)", () => {
    const view = readMatrix(largeCase.model, largeCase.value);
    if (view.status === "ready") {
      applyOp(largeCase.model, view.cells, {
        type: "cell",
        cell: `${largeCase.model.rows[3]?.id ?? "collections:users"}#read`,
        on: true,
      });
    }
  });

  bench(
    "client: mount (small)",
    async () => {
      await mount(smallCase);
      await unmount();
    },
    { iterations: 30 },
  );

  bench(
    "client: mount (large)",
    async () => {
      await mount(largeCase);
      await unmount();
    },
    { iterations: 15 },
  );

  bench(
    "client: one cell click (large)",
    async () => {
      const box = grantableBoxes()[5];
      await act(async () => {
        box?.click();
      });
    },
    {
      iterations: 60,
      setup: async () => {
        await mount(largeCase);
      },
      teardown: async () => {
        await unmount();
      },
    },
  );
});
