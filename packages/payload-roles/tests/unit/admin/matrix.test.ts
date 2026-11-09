import { describe, expect, test } from "vitest";

import type { Grant } from "../../../src/contract.ts";
import { grantsOf, parsePermissions, serializePermissions } from "../../../src/grants.ts";
import {
  applyOp,
  type Cells,
  type MatrixOp,
  type MatrixView,
  pickerWarning,
  placeFieldErrors,
  readMatrix,
} from "../../../src/admin/client/matrix.ts";
import type { CellMode, MatrixModel } from "../../../src/admin/model.ts";
import { holding, modelOf, registry } from "./fixture.ts";

const cellsOf = (view: MatrixView): Grant[] => {
  if (view.status !== "ready") {
    throw new Error("expected a readable value");
  }
  return [...view.cells].toSorted();
};

const cellsWhere = (model: MatrixModel, keep: (mode: CellMode) => boolean): Grant[] =>
  model.rows.flatMap((row) =>
    model.columns.flatMap(({ action }): Grant[] => {
      const mode = row.cells[action];
      return mode !== undefined && keep(mode) ? [`${row.id}#${action}`] : [];
    }),
  );

const applicableCells = (model: MatrixModel) => cellsWhere(model, () => true);

const publishWithoutUpdate = (model: MatrixModel, cells: Cells) =>
  model.rows.filter((row) => cells.has(`${row.id}#publish`) && !cells.has(`${row.id}#update`));

const run = (model: MatrixModel, cells: Iterable<Grant>, ...ops: MatrixOp[]) => {
  let current: Cells = new Set(cells);
  let skipped: readonly Grant[] = [];
  for (const op of ops) {
    const outcome = applyOp(model, current, op);
    current = outcome.cells;
    ({ skipped } = outcome);
  }
  return { cells: [...current].toSorted(), skipped: [...skipped].toSorted() };
};

const random = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("reading the field value", () => {
  const model = modelOf({ value: { sentinel: true } });

  const hostile: { name: string; raw: unknown; readable: boolean }[] = [
    { name: "empty object", raw: {}, readable: true },
    { name: "null", raw: null, readable: true },
    { name: "undefined", raw: undefined, readable: true },
    {
      name: "canonical value",
      raw: {
        collections: { pages: { actions: ["read", "update", "publish"] } },
        globals: { settings: { actions: ["read"] } },
      },
      readable: true,
    },
    {
      name: "one kind only",
      raw: { globals: { settings: { actions: ["update"] } } },
      readable: true,
    },
    {
      name: "duplicates",
      raw: { collections: { posts: { actions: ["read", "read"] } } },
      readable: true,
    },
    { name: "an array", raw: [], readable: false },
    { name: "a string", raw: "{}", readable: false },
    { name: "a number", raw: 1, readable: false },
    { name: "unknown kind", raw: { blocks: {} }, readable: false },
    { name: "prototype kind", raw: { toString: {} }, readable: false },
    { name: "kind not an object", raw: { collections: [] }, readable: false },
    {
      name: "unknown slug",
      raw: { collections: { ghost: { actions: ["read"] } } },
      readable: false,
    },
    {
      name: "global under collections",
      raw: { collections: { settings: { actions: ["read"] } } },
      readable: false,
    },
    {
      name: "prototype slug",
      raw: JSON.parse('{"collections":{"__proto__":{"actions":["read"]}}}'),
      readable: false,
    },
    {
      name: "extra entry key",
      raw: { collections: { pages: { actions: [], x: 1 } } },
      readable: false,
    },
    {
      name: "actions not an array",
      raw: { collections: { pages: { actions: "read" } } },
      readable: false,
    },
    {
      name: "unknown action",
      raw: { collections: { pages: { actions: ["bogus"] } } },
      readable: false,
    },
    { name: "numeric action", raw: { collections: { pages: { actions: [1] } } }, readable: false },
    {
      name: "inapplicable action",
      raw: { collections: { posts: { actions: ["publish"] } } },
      readable: false,
    },
    {
      name: "create on a global",
      raw: { globals: { settings: { actions: ["create"] } } },
      readable: false,
    },
    {
      name: "publish without update",
      raw: { collections: { pages: { actions: ["read", "publish"] } } },
      readable: false,
    },
  ];

  test.each(hostile)(
    "$name never shows a cell the server parser does not grant",
    ({ raw, readable }) => {
      const view = readMatrix(model, raw);
      expect(view.status).toBe(readable ? "ready" : "unreadable");
      if (view.status === "ready") {
        expect(cellsOf(view)).toEqual([...parsePermissions(raw, registry).grants].toSorted());
      }
    },
  );

  test("a value the decoder rejects shows the server's parse while it is the stored value", () => {
    const stored = {
      collections: {
        pages: { actions: ["read", "publish", "bogus"] },
        ghost: { actions: ["read"] },
      },
      extra: true,
    };
    const malformed = modelOf({ value: stored });
    const view = readMatrix(malformed, JSON.parse(JSON.stringify(stored)));
    expect(view).toMatchObject({ status: "ready", untouched: true });
    expect(cellsOf(view)).toEqual(["collections:pages#publish", "collections:pages#read"]);
    expect(readMatrix(malformed, { ...stored, extra: false }).status).toBe("unreadable");
  });

  test("a decoded value is untouched only while it equals the stored value", () => {
    const stored = { collections: { pages: { actions: ["read"] } }, globals: {} };
    const decoded = modelOf({ value: stored });
    expect(readMatrix(decoded, stored)).toMatchObject({ status: "ready", untouched: true });
    expect(readMatrix(decoded, { collections: {}, globals: {} })).toMatchObject({
      status: "ready",
      untouched: false,
    });
  });
});

describe("writing cells", () => {
  const admin = modelOf();

  test("every write is the canonical serializePermissions value, key order included", () => {
    const next = random(7);
    const all = applicableCells(admin);
    for (let round = 0; round < 200; round += 1) {
      const picked = all.filter(() => next() < 0.4);
      const { value, cells } = picked.reduce(
        (outcome, cell) => applyOp(admin, outcome.cells, { type: "cell", cell, on: true }),
        applyOp(admin, new Set(), { type: "clean" }),
      );
      const canonical = serializePermissions(grantsOf(cells), registry);
      expect(JSON.stringify(value)).toBe(JSON.stringify(canonical));
      expect(cellsOf(readMatrix(admin, value))).toEqual([...cells].toSorted());
    }
  });

  test("checking publish checks update and unchecking update unchecks publish", () => {
    expect(
      run(admin, [], { type: "cell", cell: "collections:pages#publish", on: true }).cells,
    ).toEqual(["collections:pages#publish", "collections:pages#update"]);
    expect(
      run(admin, ["collections:pages#publish", "collections:pages#update"], {
        type: "cell",
        cell: "collections:pages#update",
        on: false,
      }).cells,
    ).toEqual([]);
  });

  test("row and column toggles turn everything on, then off once all are on", () => {
    const row: MatrixOp = { type: "row", row: "globals:settings" };
    expect(run(admin, ["globals:settings#read"], row).cells).toEqual([
      "globals:settings#publish",
      "globals:settings#read",
      "globals:settings#readVersions",
      "globals:settings#unpublish",
      "globals:settings#update",
    ]);
    expect(run(admin, ["globals:settings#read"], row, row).cells).toEqual([]);

    const column: MatrixOp = {
      type: "column",
      action: "publish",
      rows: ["collections:pages", "collections:posts"],
    };
    expect(run(admin, [], column).cells).toEqual([
      "collections:pages#publish",
      "collections:pages#update",
    ]);
    expect(run(admin, [], column, column).cells).toEqual(["collections:pages#update"]);
  });

  test("a column toggle changes only the rows it is given", () => {
    expect(
      run(admin, [], {
        type: "column",
        action: "read",
        rows: ["collections:posts", "globals:settings"],
      }).cells,
    ).toEqual(["collections:posts#read", "globals:settings#read"]);
  });

  test("copy replaces every grantable cell with the source's", () => {
    const source = {
      id: "2",
      name: "Editor",
      granted: ["collections:posts#read", "collections:posts#update"] satisfies Grant[],
    };
    expect(run(admin, ["collections:pages#read"], { type: "copy", source })).toEqual({
      cells: ["collections:posts#read", "collections:posts#update"],
      skipped: [],
    });
  });

  test("copying publish without update lands neither and reports publish as skipped", () => {
    const source = {
      id: "2",
      name: "Broken",
      granted: ["collections:pages#publish"] satisfies Grant[],
    };
    expect(run(admin, [], { type: "copy", source })).toEqual({
      cells: [],
      skipped: ["collections:pages#publish"],
    });
  });

  test("clean drops a stored publish without update", () => {
    expect(
      run(admin, ["collections:pages#publish", "collections:pages#read"], { type: "clean" }).cells,
    ).toEqual(["collections:pages#read"]);
  });
});

describe("cells the editor cannot change", () => {
  const editor = holding(
    "collections:pages#read",
    "collections:pages#update",
    "collections:pages#publish",
    "collections:posts#read",
    "collections:roles#read",
    "collections:roles#update",
  );
  const member = modelOf({ editor, existing: false });

  test("no op changes a fixed cell, and copy reports the cells it could not set", () => {
    const start: Grant[] = ["collections:posts#update", "globals:settings#read"];
    const source = {
      id: "3",
      name: "Other",
      granted: ["collections:pages#read", "collections:posts#delete"] satisfies Grant[],
    };
    expect(run(member, start, { type: "copy", source })).toEqual({
      cells: [
        "collections:pages#read",
        "collections:posts#update",
        "globals:settings#read",
      ].toSorted(),
      skipped: [
        "collections:posts#delete",
        "collections:posts#update",
        "globals:settings#read",
      ].toSorted(),
    });
    expect(run(member, start, { type: "row", row: "collections:posts" }).cells).toEqual(
      ["collections:posts#read", "collections:posts#update", "globals:settings#read"].toSorted(),
    );
    expect(run(member, start, { type: "cell", cell: "globals:settings#read", on: false })).toEqual({
      cells: start.toSorted(),
      skipped: ["globals:settings#read"],
    });
  });

  test("update stays on while a publish the editor cannot change stays on", () => {
    const publisher = modelOf({ editor: holding("collections:pages#update"), existing: false });
    expect(
      run(publisher, ["collections:pages#publish", "collections:pages#update"], {
        type: "cell",
        cell: "collections:pages#update",
        on: false,
      }),
    ).toEqual({
      cells: ["collections:pages#publish", "collections:pages#update"],
      skipped: ["collections:pages#update"],
    });
  });

  test("random op sequences keep fixed cells and never leave publish without update", () => {
    const models = [
      modelOf(),
      member,
      modelOf({ editor: holding("collections:pages#update", "globals:settings#publish") }),
      modelOf({ options: { enabled: false, rolesSlug: "roles", userCollection: "users" }, editor }),
    ];
    const next = random(42);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) {
        throw new Error("empty pick");
      }
      return item;
    };
    for (let sequence = 0; sequence < 500; sequence += 1) {
      const model = pick(models);
      const all = applicableCells(model);
      const start = new Set(all.filter(() => next() < 0.3));
      for (const row of publishWithoutUpdate(model, start)) {
        start.delete(`${row.id}#publish`);
      }
      const fixed = cellsWhere(model, (mode) => mode === "fixed").map(
        (cell) => [cell, start.has(cell)] as const,
      );
      let cells: Cells = start;
      for (let step = 0; step < 12; step += 1) {
        const kind = next();
        const op: MatrixOp =
          kind < 0.5
            ? { type: "cell", cell: pick(all), on: next() < 0.5 }
            : kind < 0.65
              ? { type: "row", row: pick(model.rows).id }
              : kind < 0.8
                ? {
                    type: "column",
                    action: pick(model.columns).action,
                    rows: model.rows.filter(() => next() < 0.6).map(({ id }) => id),
                  }
                : kind < 0.95
                  ? {
                      type: "copy",
                      source: { id: "s", name: "s", granted: all.filter(() => next() < 0.4) },
                    }
                  : { type: "clean" };
        cells = applyOp(model, cells, op).cells;
        expect(publishWithoutUpdate(model, cells)).toEqual([]);
        for (const [cell, on] of fixed) {
          expect(cells.has(cell), cell).toBe(on);
        }
      }
    }
  });
});

describe("the Roles picker warning", () => {
  const model = modelOf();
  test.each([
    { cells: [], warns: false },
    { cells: ["collections:users#update"], warns: true },
    { cells: ["collections:users#create"], warns: true },
    { cells: ["collections:users#update", "collections:roles#read"], warns: false },
    { cells: ["collections:roles#read"], warns: false },
  ] satisfies { cells: Grant[]; warns: boolean }[])("$cells warns: $warns", ({ cells, warns }) => {
    expect(pickerWarning(model, new Set(cells))).toBe(warns);
  });

  test("is off when users is not a managed resource", () => {
    const unmanaged = modelOf({
      options: { enabled: true, rolesSlug: "roles", userCollection: "members" },
    });
    expect(pickerWarning(unmanaged, new Set(["collections:users#update"]))).toBe(false);
  });
});

describe("server errors", () => {
  const model = modelOf();
  const notHeld =
    'You cannot grant action "publish" on "collections:pages" because you do not hold it.';
  const needsUpdate = 'Action "publish" requires "update" on the same resource.';
  const inapplicable = 'Action "create" does not apply to "globals:settings".';

  test("each line of core's field error lands on the row its path names", () => {
    const message = [
      `permissions.collections.pages.actions: ${notHeld}`,
      `permissions.collections.pages.actions: ${needsUpdate}`,
      `permissions.globals.settings.actions: ${inapplicable}`,
    ].join("\n");
    const placed = placeFieldErrors(model, message);
    expect([...placed.byRow]).toEqual([
      ["collections:pages", [notHeld, needsUpdate]],
      ["globals:settings", [inapplicable]],
    ]);
    expect(placed.field).toEqual([]);
  });

  test("lines that name no row, and plain messages, stay at field level", () => {
    const lines = [
      "permissions.collections: Permissions must be an object.",
      'permissions.collections.ghost.actions: "collections:ghost" is not managed by the roles plugin.',
      "This field is required.",
    ];
    const placed = placeFieldErrors(model, lines.join("\n"));
    expect(placed.byRow.size).toBe(0);
    expect(placed.field).toEqual(lines);
  });

  test("no message places nothing", () => {
    const placed = placeFieldErrors(model, "");
    expect(placed.byRow.size).toBe(0);
    expect(placed.field).toEqual([]);
  });
});
