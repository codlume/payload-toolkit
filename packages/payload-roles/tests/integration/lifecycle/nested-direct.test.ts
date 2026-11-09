import {
  type CollectionBeforeChangeHook,
  type CollectionBeforeValidateHook,
  updateByIDOperation,
} from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, fixtureCollections, type TestPayload } from "../../helpers/payload.ts";

type Nested = "caught-error" | "different-id" | "same-id";

type At = "beforeChange" | "beforeValidate";

type Plan = { at: At; nested: Nested; outerId: number | string; otherId: number | string };

let context: TestPayload;
let users: Record<"publisher" | "updateOnly", Actor>;
let plan: null | Plan = null;
const nestedOutcomes: string[] = [];

const runNested = async (req: Parameters<CollectionBeforeChangeHook>[0]["req"]) => {
  const current = plan;
  const collection = req.payload.collections.pages;
  if (!current || !collection || !req.user || req.context.nestedRan === true) {
    return;
  }
  req.context.nestedRan = true;
  const id =
    current.nested === "same-id"
      ? current.outerId
      : current.nested === "different-id"
        ? current.otherId
        : 987_654_321;
  try {
    await updateByIDOperation({
      collection,
      data: {},
      depth: 0,
      disableTransaction: true,
      id,
      overrideAccess: true,
      req,
    });
    nestedOutcomes.push("ok");
  } catch (error) {
    nestedOutcomes.push(error instanceof Error ? error.name : "error");
  }
};

const inBeforeValidate: CollectionBeforeValidateHook = async ({ data, req }) => {
  if (plan?.at === "beforeValidate") {
    await runNested(req);
  }
  return data;
};

const inBeforeChange: CollectionBeforeChangeHook = async ({ data, req }) => {
  if (plan?.at === "beforeChange") {
    await runNested(req);
  }
  return data;
};

beforeAll(async () => {
  context = await createTestPayload({
    collections: fixtureCollections().map((collection) =>
      collection.slug === "pages"
        ? Object.assign(collection, {
            hooks: { beforeChange: [inBeforeChange], beforeValidate: [inBeforeValidate] },
          })
        : collection,
    ),
    name: "lifecycle-nested-direct",
  });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const member = async (key: string, actions: string[]) =>
    seedUser(payload, {
      email: `${key}@example.com`,
      roles: [await seedRole(payload, key, { collections: { pages: { actions } } })],
    });
  users = {
    publisher: await member("publisher", ["read", "update", "publish"]),
    updateOnly: await member("update-only", ["read", "update"]),
  };
});

afterAll(() => context.destroy());

const livePage = async (title: string) =>
  (await context.payload.create({ collection: "pages", data: { _status: "published", title } })).id;

const title = async (id: number | string) =>
  (
    await context.payload.db.findOne<{ id: number | string; title?: unknown }>({
      collection: "pages",
      where: { id: { equals: id } },
    })
  )?.title;

const setup = async (at: At, nested: Nested, label: string) => {
  plan = null;
  const outerId = await livePage(`${label} outer`);
  const otherId = await livePage(`${label} other`);
  plan = { at, nested, otherId, outerId };
  nestedOutcomes.length = 0;
  return { otherId, outerId };
};

const NESTED: readonly { nested: Nested; expected: string }[] = [
  { nested: "different-id", expected: "ok" },
  { nested: "same-id", expected: "ok" },
  { nested: "caught-error", expected: "NotFound" },
];

describe.each(["beforeValidate", "beforeChange"] as const)(
  "an app %s hook that runs a direct trusted operation with disableTransaction",
  (at) => {
    test.each(NESTED)(
      "($nested) leaves the outer update-only live edit refused over REST",
      async ({ nested, expected }) => {
        const { outerId } = await setup(at, nested, `${at} ${nested} rest`);
        const api = rest(context, await login(context.payload, users.updateOnly.email));

        const response = await api("PATCH", `/pages/${outerId}`, {
          title: "edited without publish",
        });

        expect(response.status, "the outer live edit needs publish").toBe(403);
        expect(await title(outerId)).toBe(`${at} ${nested} rest outer`);
        expect(nestedOutcomes, "the nested call ran as the app intended").toEqual([expected]);
      },
    );

    test.each(NESTED)(
      "($nested) leaves the outer update-only live edit refused over the Local API",
      async ({ nested, expected }) => {
        const { outerId } = await setup(at, nested, `${at} ${nested} local`);

        await rejectsWith(
          as(context.payload, users.updateOnly).update({
            collection: "pages",
            data: { title: "edited without publish" },
            id: outerId,
          }),
          "Forbidden",
        );

        expect(await title(outerId)).toBe(`${at} ${nested} local outer`);
        expect(nestedOutcomes).toEqual([expected]);
      },
    );

    test("still allows a publisher's live edit alongside the nested call", async () => {
      const { outerId } = await setup(at, "different-id", `${at} publisher`);

      await as(context.payload, users.publisher).update({
        collection: "pages",
        data: { title: "edited by publisher" },
        id: outerId,
      });

      expect(await title(outerId)).toBe("edited by publisher");
      expect(nestedOutcomes).toEqual(["ok"]);
    });
  },
);
