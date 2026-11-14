// A refused role save must leave Payload's admin form able to send the editor's next attempt.
// The reducer is Payload's own (`@payloadcms/ui` does not export it), driven the way its Form
// handles a 400: field errors go through ADD_SERVER_ERRORS, the next save sends
// `reduceFieldsToValues(fields, true)`.
import { reduceFieldsToValues } from "payload/shared";
import { afterAll, beforeAll, expect, test } from "vitest";

import {
  type Actor,
  login,
  type RestResponse,
  rest,
  seedRole,
  seedUser,
} from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

type FormField = { value: unknown; initialValue: unknown; valid: boolean; errorMessage?: string };
type FormState = Record<string, FormField>;
type FormAction =
  | { type: "ADD_SERVER_ERRORS"; errors: { path: string; message: string }[] }
  | { type: "UPDATE"; path: string; value: unknown };

const formModule: { fieldReducer: (state: FormState, action: FormAction) => FormState } =
  await import(new URL("fieldReducer.js", import.meta.resolve("@payloadcms/ui/forms/Form")).href);
const { fieldReducer } = formModule;

let context: TestPayload;
let role: number | string;
let editor: Actor;

beforeAll(async () => {
  context = await createTestPayload({ name: "form-errors" });
  const { payload } = context;
  await seedUser(payload, { email: "super@example.com" });
  const rolesAdmin = await seedRole(payload, "roles-admin", {
    collections: {
      pages: { actions: ["read"] },
      roles: { actions: ["read", "create", "update", "delete"] },
    },
  });
  role = await seedRole(payload, "pages-reader", { collections: { pages: { actions: ["read"] } } });
  editor = await seedUser(payload, { email: "roles-editor@example.com", roles: [rolesAdmin] });
});

afterAll(() => context.destroy());

const storedPermissions = async () =>
  (await context.payload.findByID({ collection: "roles", depth: 0, id: role })).permissions;

/** The field errors Payload's Form dispatches from a failed save's JSON. */
const fieldErrorsOf = (response: RestResponse) => {
  const errors: unknown = response.json?.errors;
  return (Array.isArray(errors) ? errors : []).flatMap((error: { data?: { errors?: unknown } }) =>
    Array.isArray(error.data?.errors)
      ? error.data.errors.filter((entry: { path?: unknown }) => typeof entry.path === "string")
      : [],
  );
};

const field = (value: unknown): FormField => ({ initialValue: value, valid: true, value });

/**
 * Opens the role in the form, saves `first`, then edits the JSON to `second` and saves again.
 * Each edit is a fresh object, as the JSON editor parses one per keystroke.
 */
const saveTwice = async (first: unknown, second: unknown) => {
  const save = rest(context, await login(context.payload, editor.email));
  let state: FormState = {
    key: field("pages-reader"),
    name: field("pages-reader"),
    permissions: field(await storedPermissions()),
  };
  state = fieldReducer(state, {
    type: "UPDATE",
    path: "permissions",
    value: structuredClone(first),
  });
  const refused = await save("PATCH", `/roles/${role}`, reduceFieldsToValues(state, true));
  state = fieldReducer(state, { type: "ADD_SERVER_ERRORS", errors: fieldErrorsOf(refused) });
  state = fieldReducer(state, {
    type: "UPDATE",
    path: "permissions",
    value: structuredClone(second),
  });
  const sent: unknown = reduceFieldsToValues(state, true);
  return { refused, retried: await save("PATCH", `/roles/${role}`, sent), sent };
};

const notHeld = { collections: { pages: { actions: ["read", "update"] } } };

test("a refused permissions save names the field and the cell, and the form's next save sends the edit", async () => {
  const within = { collections: { pages: { actions: ["read"] }, roles: { actions: ["read"] } } };

  const { refused, retried, sent } = await saveTwice(notHeld, within);

  expect(refused.status).toBe(400);
  expect(sent).toEqual(expect.objectContaining({ permissions: within }));
  expect(retried.status).toBe(200);
  expect(await storedPermissions()).toEqual({ ...within, globals: {} });
  expect(fieldErrorsOf(refused)).toEqual([
    {
      message: expect.stringMatching(/permissions\.collections\.pages\.actions.*"update"/),
      path: "permissions",
    },
  ]);
});

test("the form's next save is still refused while it keeps a cell the editor does not hold", async () => {
  const before = await storedPermissions();

  const { refused, retried } = await saveTwice(notHeld, notHeld);

  expect(refused.status).toBe(400);
  expect(retried.status).toBe(400);
  expect(fieldErrorsOf(retried)).toEqual([
    { message: expect.stringContaining('"update"'), path: "permissions" },
  ]);
  expect(await storedPermissions()).toEqual(before);
});
