import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { NO_CAPABILITIES } from "../../../src/grants.ts";
import { PermissionsMatrix } from "../../../src/admin/client/permissions-matrix.tsx";
import type { MatrixModel, ResourceId } from "../../../src/admin/model.ts";
import { holding, modelOf } from "./fixture.ts";

type FieldState = { value: unknown; errorMessage: string | undefined; showError: boolean };

const field = vi.hoisted(() => {
  const state: FieldState = { value: undefined, errorMessage: undefined, showError: false };
  return state;
});

// The @payloadcms/ui root imports CSS, which Node cannot load.
vi.mock("@payloadcms/ui", () => ({
  FieldDescription: () => null,
  FieldLabel: () => null,
  useField: () => ({ ...field, setValue: () => undefined }),
}));

beforeEach(() => {
  field.value = undefined;
  field.errorMessage = undefined;
  field.showError = false;
});

const render = (model: MatrixModel, value: unknown = {}) => {
  field.value = value;
  return renderToStaticMarkup(
    <PermissionsMatrix
      field={{ name: "permissions", type: "json" }}
      model={model}
      path="permissions"
    />,
  );
};

const tags = (markup: string, name: string) =>
  markup.match(new RegExp(`<${name}\\b[^>]*>`, "gu")) ?? [];

const checkbox = (markup: string, label: string) =>
  tags(markup, "input").find((tag) => tag.includes(`aria-label="${label}"`));

const labels = new Map<ResourceId, string>([
  ["collections:pages", "Pages"],
  ["collections:posts", "Posts"],
  ["globals:settings", "Settings"],
]);

describe("table semantics", () => {
  const markup = render(modelOf({ labels }));

  test("is a captioned table with column, row and row group headers", () => {
    expect(markup).toMatch(/<table>\s*<caption[^>]*>[^<]+<\/caption>/u);
    expect(tags(markup, "th").filter((tag) => tag.includes('scope="col"')).length).toBeGreaterThan(
      9,
    );
    expect(markup).toContain('<th scope="row">Pages</th>');
    expect(markup).toMatch(/<th colSpan="\d+" scope="rowgroup">Collections<\/th>/u);
    expect(markup).toMatch(/<th colSpan="\d+" scope="rowgroup">Globals<\/th>/u);
  });

  test("a non-applicable cell is blank for sight and says so to a screen reader", () => {
    expect(checkbox(markup, "Posts: Publish")).toBeUndefined();
    expect(checkbox(markup, "Settings: Create")).toBeUndefined();
    expect(checkbox(markup, "Pages: Publish")).toBeDefined();
    expect(markup).toContain('<td><span class="roles-matrix__sr">Not applicable</span></td>');
  });

  test("every checkbox is native and labelled, and every button is a plain button", () => {
    const inputs = tags(markup, "input").filter((tag) => tag.includes('type="checkbox"'));
    expect(inputs.length).toBeGreaterThan(20);
    for (const tag of inputs) {
      expect(tag).toMatch(/aria-label="[^"]+: [^"]+"/u);
    }
    for (const tag of tags(markup, "button")) {
      expect(tag).toContain('type="button"');
    }
  });

  test("the filter is a labelled search box", () => {
    const search = tags(markup, "input").find((tag) => tag.includes('type="search"'));
    const id = search?.match(/id="([^"]+)"/u)?.[1];
    expect(id).toBeDefined();
    expect(markup).toContain(`<label for="${id ?? ""}">Filter resources</label>`);
  });

  test("its inline styles never animate", () => {
    const css = markup.match(/<style>([\s\S]*?)<\/style>/u)?.[1] ?? "";
    expect(css).toContain("position: sticky");
    expect(css).not.toMatch(/transition|animation/u);
  });
});

describe("what the editor can change", () => {
  test("cells the editor cannot grant are disabled", () => {
    const markup = render(modelOf({ editor: holding("collections:pages#read"), labels }));
    expect(checkbox(markup, "Pages: Read")).not.toContain("disabled");
    expect(checkbox(markup, "Pages: Delete")).toContain("disabled");
  });

  test("checked cells follow the field value", () => {
    const markup = render(modelOf({ labels }), {
      collections: { pages: { actions: ["read"] } },
    });
    expect(checkbox(markup, "Pages: Read")).toContain("checked");
    expect(checkbox(markup, "Pages: Update")).not.toContain("checked");
  });

  test("a read-only role says so", () => {
    expect(render(modelOf({ readOnly: true }))).toContain(
      "You can view this role but cannot change it.",
    );
  });

  test("a role the editor does not cover names the cells that block it", () => {
    const markup = render(
      modelOf({
        editor: holding("collections:roles#update"),
        labels,
        value: { collections: { pages: { actions: ["delete"] } } },
      }),
      { collections: { pages: { actions: ["delete"] } } },
    );
    expect(markup).toContain("permissions you do not hold: Pages: Delete.");
    expect(checkbox(markup, "Pages: Delete")).toContain("disabled");
  });

  test("disabled mode says limits are not enforced", () => {
    const markup = render(
      modelOf({
        editor: NO_CAPABILITIES,
        options: { enabled: false, rolesSlug: "roles", userCollection: "users" },
      }),
    );
    expect(markup).toContain("Role limits are not enforced.");
    expect(checkbox(markup, "pages: Delete")).not.toContain("disabled");
  });
});

describe("values the matrix cannot write", () => {
  test("a stored value with invalid entries lists them and offers to remove them", () => {
    const value = { collections: { pages: { actions: ["read", "bogus"] } } };
    const markup = render(modelOf({ labels, value }), value);
    expect(markup).toContain("Unknown action; expected one of");
    expect(markup).toContain("Remove invalid entries");
    expect(checkbox(markup, "Pages: Read")).toContain("checked");
  });

  test("a value it can neither decode nor match is unreadable, with every control off", () => {
    const markup = render(modelOf({ labels }), { collections: { pages: { actions: ["bogus"] } } });
    expect(markup).toContain("cannot be shown as a matrix");
    for (const tag of tags(markup, "input").filter((input) => input.includes('type="checkbox"'))) {
      expect(tag).toContain("disabled");
    }
  });
});

describe("notices and links", () => {
  test("warns when holders can edit users but not read roles", () => {
    const warning = "the Roles picker on a user stays empty without Read on";
    expect(render(modelOf(), { collections: { users: { actions: ["update"] } } })).toContain(
      warning,
    );
    expect(
      render(modelOf(), {
        collections: { users: { actions: ["update"] }, roles: { actions: ["read"] } },
      }),
    ).not.toContain(warning);
  });

  test("links to the users holding the role and lists the roles to copy", () => {
    const markup = render(
      modelOf({
        assignment: { count: 3, href: "/admin/collections/users?x=1" },
        copySources: [{ id: "7", name: "Editor", granted: [] }],
      }),
    );
    expect(markup).toContain('<a href="/admin/collections/users?x=1">Assigned to 3 users</a>');
    expect(markup).toContain('<option value="7">Editor</option>');
    expect(markup).toMatch(/<label for="[^"]+">Copy from role<\/label>/u);
  });

  test("shows the field's own error after a submit", () => {
    field.showError = true;
    field.errorMessage = "This field is required.";
    expect(render(modelOf(), {})).toContain("This field is required.");
  });

  test("puts each line of a refused save on the row it names, and the rest above the table", () => {
    const model = modelOf();
    const pages = model.rows.find((row) => row.id === "collections:pages");
    const notHeld =
      'You cannot grant action "delete" on "collections:pages" because you do not hold it.';
    const shape = "permissions.collections: Permissions must be an object.";
    field.errorMessage = `permissions.collections.pages.actions: ${notHeld}\n${shape}`;

    expect(render(model, {})).not.toContain(notHeld);

    field.showError = true;
    const markup = render(model, {});
    const pagesRow = markup
      .split("<tr>")
      .find((row) => row.includes(`aria-label="${pages?.label ?? ""}: Read"`));
    expect(pagesRow).toContain(
      `<span class="roles-matrix__error" role="alert">${notHeld.replaceAll('"', "&quot;")}</span>`,
    );
    expect(markup).toContain(`<li>${shape}</li>`);
    expect(markup.split(notHeld.replaceAll('"', "&quot;")).length - 1).toBe(1);
  });
});
