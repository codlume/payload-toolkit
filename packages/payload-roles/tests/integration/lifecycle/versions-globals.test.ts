import { Forbidden } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  type Actor,
  as,
  graphql,
  login,
  type Permissions,
  rest,
  seedRole,
  seedUser,
} from "../../helpers/actors.ts";
import { rejectsWith } from "../../helpers/expect.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

const pages = (actions: string[]): Permissions => ({ collections: { pages: { actions } } });
const settings = (actions: string[]): Permissions => ({ globals: { settings: { actions } } });

const ROLES = {
  pagesFull: pages(["read", "update", "publish", "unpublish", "readVersions"]),
  pagesNoVersions: pages(["read", "update", "publish", "unpublish"]),
  pagesNoPublish: pages(["read", "update", "unpublish", "readVersions"]),
  pagesNoUnpublish: pages(["read", "update", "publish", "readVersions"]),
  pagesEditorVersions: pages(["read", "update", "readVersions"]),
  settingsFull: settings(["read", "update", "publish", "unpublish", "readVersions"]),
  settingsEditor: settings(["read", "update"]),
  settingsPublisher: settings(["read", "update", "publish"]),
  settingsUnpublisher: settings(["read", "unpublish"]),
  settingsNoVersions: settings(["read", "update", "publish", "unpublish"]),
  settingsPublisherVersions: settings(["read", "update", "publish", "readVersions"]),
  settingsUnpublisherVersions: settings(["read", "update", "unpublish", "readVersions"]),
  settingsEditorVersions: settings(["read", "update", "readVersions"]),
} satisfies Record<string, Permissions>;

type ActorName = keyof typeof ROLES;
type Surface = "graphql" | "local" | "rest";
type Attempt = "allowed" | "forbidden" | `unexpected ${string}`;
type Row = Record<string, unknown>;
type Stored = { main: Row; newest: Row | undefined };
type Step = { data: Row; draft: boolean };

let context: TestPayload;
const actors = new Map<string, { actor: Actor; token: string }>();

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-versions-globals" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  await Promise.all(
    Object.entries(ROLES).map(async ([name, permissions]) => {
      const key = name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const actor = await seedUser(payload, {
        email: `${key}@example.com`,
        roles: [await seedRole(payload, key, permissions)],
      });
      actors.set(name, { actor, token: await login(payload, actor.email) });
    }),
  );
});

afterAll(() => context.destroy());

const actorFor = (name: ActorName) => {
  const entry = actors.get(name);
  if (!entry) {
    throw new Error(`actor ${name} was not seeded`);
  }
  return entry;
};

const FORBIDDEN_MESSAGE = new Forbidden().message;

const pick = (row: Row | null | undefined, keys: readonly string[]): Row =>
  Object.fromEntries(keys.map((key) => [key, row?.[key]]));

const fromRest = ({ status, json }: Awaited<ReturnType<ReturnType<typeof rest>>>): Attempt => {
  if (status === 200) {
    return "allowed";
  }
  return status === 403 ? "forbidden" : `unexpected ${status} ${JSON.stringify(json)}`;
};

const fromLocal = async (operation: () => Promise<unknown>): Promise<Attempt> => {
  try {
    await operation();
    return "allowed";
  } catch (error) {
    if (error instanceof Error && error.name === "Forbidden") {
      return "forbidden";
    }
    return `unexpected ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
};

const fromGraphql = (
  field: string,
  { data, errors }: Awaited<ReturnType<typeof graphql>>,
): Attempt => {
  const value = data?.[field];
  if (!errors && value) {
    return "allowed";
  }
  if (value === null && errors?.length === 1 && errors[0]?.message === FORBIDDEN_MESSAGE) {
    return "forbidden";
  }
  return `unexpected ${JSON.stringify({ data, errors })}`;
};

const expectOutcome = async ({
  attempt,
  effect,
  outcome,
  stored,
}: {
  attempt: () => Promise<Attempt>;
  effect: Partial<Stored>;
  outcome: "allowed" | "forbidden";
  stored: () => Promise<Stored>;
}) => {
  const before = await stored();
  expect(await attempt()).toBe(outcome);
  if (outcome === "allowed") {
    expect(await stored()).toMatchObject(effect);
  } else {
    expect(await stored(), "a denied request writes nothing").toEqual(before);
  }
};

const published = (data: Row): Step => ({ data: { ...data, _status: "published" }, draft: false });
const unpublished = (data: Row): Step => ({ data: { ...data, _status: "draft" }, draft: false });

const inOrder = (writes: (() => Promise<unknown>)[]) =>
  writes.reduce<Promise<unknown>>((previous, write) => previous.then(write), Promise.resolve());

const cases = <Case extends { allowed: ActorName[]; denied: ActorName[]; surfaces: Surface[] }>(
  list: Case[],
) =>
  list.flatMap((entry) =>
    entry.surfaces.flatMap((surface) => [
      ...entry.allowed.map((actor) => ({ ...entry, actor, outcome: "allowed" as const, surface })),
      ...entry.denied.map((actor) => ({ ...entry, actor, outcome: "forbidden" as const, surface })),
    ]),
  );

describe("collection restoreVersion on pages", () => {
  const PAGE = ["_status", "title"] as const;

  const storedPage = (id: number | string) => async (): Promise<Stored> => {
    const { db } = context.payload;
    const [main, { docs }] = await Promise.all([
      db.findOne({ collection: "pages", where: { id: { equals: id } } }),
      db.findVersions({
        collection: "pages",
        limit: 1,
        pagination: false,
        sort: "-id",
        where: { parent: { equals: id } },
      }),
    ]);
    const newest = docs[0];
    return {
      main: pick(main, PAGE),
      newest: newest && { ...pick(newest.version, PAGE), versionId: newest.id },
    };
  };

  const seedPage = async ([first, ...later]: [Step, ...Step[]]) => {
    const { payload } = context;
    const page = await payload.create({
      collection: "pages",
      data: first.data,
      draft: first.draft,
    });
    await inOrder(
      later.map(
        (step) => () =>
          payload.update({ collection: "pages", data: step.data, draft: step.draft, id: page.id }),
      ),
    );
    const { docs } = await payload.db.findVersions({
      collection: "pages",
      pagination: false,
      sort: "id",
      where: { parent: { equals: page.id } },
    });
    expect(docs, "each trusted step writes one version").toHaveLength(later.length + 1);
    return { id: page.id, versionIds: docs.map((version) => version.id) };
  };

  const restorePage = async ({
    actor,
    draft,
    surface,
    versionId,
  }: {
    actor: ActorName;
    draft: boolean;
    surface: Surface;
    versionId: number | string;
  }): Promise<Attempt> => {
    const { actor: user, token } = actorFor(actor);
    switch (surface) {
      case "rest":
        return fromRest(
          await rest(context, token)(
            "POST",
            `/pages/versions/${versionId}${draft ? "?draft=true" : ""}`,
          ),
        );
      case "local":
        return fromLocal(() =>
          as(context.payload, user).restoreVersion({ collection: "pages", id: String(versionId) }),
        );
      case "graphql":
        return fromGraphql(
          "restoreVersionPage",
          await graphql(
            context,
            token,
            "mutation ($id: Int, $draft: Boolean) { restoreVersionPage(id: $id, draft: $draft) { id } }",
            { draft, id: versionId },
          ),
        );
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  };

  test.each(
    cases([
      {
        allowed: ["pagesFull", "pagesNoUnpublish"],
        denied: ["pagesNoPublish", "pagesNoVersions", "pagesEditorVersions"],
        draft: false,
        effect: { main: { _status: "published", title: "v1" } },
        history: [published({ title: "v1" }), published({ title: "v2" })],
        row: "R1 restoring a published version publishes its content",
        surfaces: ["rest", "local", "graphql"],
        target: 0,
      },
      {
        allowed: ["pagesFull", "pagesNoPublish"],
        denied: ["pagesNoUnpublish", "pagesNoVersions", "pagesEditorVersions"],
        draft: false,
        effect: { main: { _status: "draft", title: "v2" } },
        history: [
          published({ title: "v1" }),
          { data: { title: "v2" }, draft: true },
          published({ title: "v3" }),
        ],
        row: "R2 restoring a draft version onto a published page unpublishes it",
        surfaces: ["rest", "local", "graphql"],
        target: 1,
      },
      {
        allowed: ["pagesFull", "pagesNoPublish", "pagesNoUnpublish", "pagesEditorVersions"],
        denied: ["pagesNoVersions"],
        draft: true,
        effect: {
          newest: { _status: "draft", title: "v1" },
          main: { _status: "published", title: "v2" },
        },
        history: [published({ title: "v1" }), published({ title: "v2" })],
        row: "R3 restoring with draft=true writes a draft version only",
        surfaces: ["rest", "graphql"],
        target: 0,
      },
      {
        allowed: ["pagesFull", "pagesNoPublish", "pagesNoUnpublish", "pagesEditorVersions"],
        denied: ["pagesNoVersions"],
        draft: false,
        effect: { main: { _status: "draft", title: "v1" } },
        history: [unpublished({ title: "v1" }), unpublished({ title: "v2" })],
        row: "R4 restoring a draft version onto an unpublished page keeps it unpublished",
        surfaces: ["rest", "local", "graphql"],
        target: 0,
      },
    ] satisfies {
      allowed: ActorName[];
      denied: ActorName[];
      draft: boolean;
      effect: Partial<Stored>;
      history: [Step, ...Step[]];
      row: string;
      surfaces: Surface[];
      target: number;
    }[]),
  )("$row: $surface as $actor is $outcome", async (entry) => {
    const { id, versionIds } = await seedPage(entry.history);
    const versionId = versionIds[entry.target];
    if (versionId === undefined) {
      throw new Error(`history has no step ${entry.target}`);
    }
    await expectOutcome({
      attempt: () =>
        restorePage({ actor: entry.actor, draft: entry.draft, surface: entry.surface, versionId }),
      effect: entry.effect,
      outcome: entry.outcome,
      stored: storedPage(id),
    });
  });
});

describe("the settings drafts global", () => {
  const SETTINGS = ["_status", "siteName"] as const;

  const newestGlobalVersion = async () =>
    (
      await context.payload.db.findGlobalVersions({
        global: "settings",
        limit: 1,
        pagination: false,
        sort: "-id",
      })
    ).docs[0];

  const storedSettings = async (): Promise<Stored> => {
    const { db } = context.payload;
    const [main, newest] = await Promise.all([
      db.findGlobal({ slug: "settings" }),
      newestGlobalVersion(),
    ]);
    return {
      main: pick(main, SETTINGS),
      newest: newest && { ...pick(newest.version, SETTINGS), versionId: newest.id },
    };
  };

  const seedSettings = async (history: Step[]) => {
    const { payload } = context;
    const before = (await newestGlobalVersion())?.id ?? 0;
    await inOrder(
      history.map(
        (step) => () =>
          payload.updateGlobal({ data: step.data, draft: step.draft, slug: "settings" }),
      ),
    );
    const { docs } = await payload.db.findGlobalVersions({
      global: "settings",
      pagination: false,
      sort: "id",
      where: { id: { greater_than: before } },
    });
    expect(docs, "each trusted step writes one version").toHaveLength(history.length);
    return docs.map((version) => version.id);
  };

  const updateSettings = async ({
    actor,
    request: { data, draft },
    surface,
  }: {
    actor: ActorName;
    request: Step;
    surface: Surface;
  }): Promise<Attempt> => {
    const { actor: user, token } = actorFor(actor);
    switch (surface) {
      case "rest":
        return fromRest(
          await rest(context, token)(
            "POST",
            `/globals/settings${draft ? "?draft=true" : ""}`,
            data,
          ),
        );
      case "local":
        return fromLocal(() =>
          as(context.payload, user).updateGlobal({ data, draft, slug: "settings" }),
        );
      case "graphql":
        return fromGraphql(
          "updateSetting",
          await graphql(
            context,
            token,
            "mutation ($data: mutationSettingInput!, $draft: Boolean) { updateSetting(data: $data, draft: $draft) { _status } }",
            { data, draft },
          ),
        );
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  };

  const restoreSettings = async ({
    actor,
    draft,
    surface,
    versionId,
  }: {
    actor: ActorName;
    draft: boolean;
    surface: Surface;
    versionId: number | string;
  }): Promise<Attempt> => {
    const { actor: user, token } = actorFor(actor);
    switch (surface) {
      case "rest":
        return fromRest(
          await rest(context, token)(
            "POST",
            `/globals/settings/versions/${versionId}${draft ? "?draft=true" : ""}`,
          ),
        );
      case "local":
        if (draft) {
          throw new Error("Local restoreGlobalVersion has no draft option");
        }
        return fromLocal(() =>
          context.payload.restoreGlobalVersion({
            id: String(versionId),
            overrideAccess: false,
            slug: "settings",
            user,
          }),
        );
      case "graphql":
        return fromGraphql(
          "restoreVersionSetting",
          await graphql(
            context,
            token,
            "mutation ($id: Int, $draft: Boolean) { restoreVersionSetting(id: $id, draft: $draft) { _status } }",
            { draft, id: versionId },
          ),
        );
      default: {
        const exhaustive: never = surface;
        return exhaustive;
      }
    }
  };

  const ALL: Surface[] = ["rest", "local", "graphql"];

  test.each(
    cases([
      {
        allowed: ["settingsEditor", "settingsPublisher", "settingsFull"],
        denied: ["settingsUnpublisher"],
        effect: {
          newest: { _status: "draft", siteName: "pending" },
          main: { _status: "published", siteName: "live" },
        },
        history: [published({ siteName: "live" })],
        request: { data: { siteName: "pending" }, draft: true },
        row: "G1 saving a draft writes a version only",
        surfaces: ALL,
      },
      {
        allowed: ["settingsPublisher", "settingsFull"],
        denied: ["settingsEditor", "settingsUnpublisher"],
        effect: { main: { _status: "published", siteName: "next" } },
        history: [unpublished({ siteName: "live" })],
        request: published({ siteName: "next" }),
        row: "G2 publishing writes the main row published",
        surfaces: ALL,
      },
      {
        allowed: ["settingsPublisher", "settingsFull"],
        denied: ["settingsEditor", "settingsUnpublisher"],
        effect: { main: { _status: "published", siteName: "edited" } },
        history: [published({ siteName: "live" })],
        request: { data: { siteName: "edited" }, draft: false },
        row: "G2 a non-draft content edit of the published global stays published",
        surfaces: ALL,
      },
      {
        allowed: ["settingsUnpublisher", "settingsFull"],
        denied: ["settingsEditor", "settingsPublisher"],
        effect: { main: { _status: "draft", siteName: "live" } },
        history: [published({ siteName: "live" })],
        request: { data: { _status: "draft" }, draft: false },
        row: "G3 a status-only unpublish writes the main row draft",
        surfaces: ALL,
      },
    ] satisfies {
      allowed: ActorName[];
      denied: ActorName[];
      effect: Partial<Stored>;
      history: Step[];
      request: Step;
      row: string;
      surfaces: Surface[];
    }[]),
  )("$row: $surface as $actor is $outcome", async (entry) => {
    await seedSettings(entry.history);
    await expectOutcome({
      attempt: () =>
        updateSettings({ actor: entry.actor, request: entry.request, surface: entry.surface }),
      effect: entry.effect,
      outcome: entry.outcome,
      stored: storedSettings,
    });
  });

  test.each(
    cases([
      {
        allowed: ["settingsFull", "settingsPublisherVersions"],
        denied: ["settingsUnpublisherVersions", "settingsEditorVersions", "settingsNoVersions"],
        draft: false,
        effect: { main: { _status: "published", siteName: "old" } },
        history: [published({ siteName: "old" }), published({ siteName: "new" })],
        row: "G4 restoring a published version publishes its content",
        surfaces: ALL,
        target: 0,
      },
      {
        allowed: ["settingsFull", "settingsUnpublisherVersions"],
        denied: ["settingsPublisherVersions", "settingsEditorVersions", "settingsNoVersions"],
        draft: true,
        effect: { main: { _status: "draft", siteName: "old" } },
        history: [published({ siteName: "old" }), published({ siteName: "new" })],
        row: "G5 restoring with draft=true unpublishes the published global",
        surfaces: ["rest", "graphql"],
        target: 0,
      },
      {
        allowed: [
          "settingsFull",
          "settingsEditorVersions",
          "settingsPublisherVersions",
          "settingsUnpublisherVersions",
        ],
        denied: ["settingsNoVersions"],
        draft: false,
        effect: { main: { _status: "draft", siteName: "first draft" } },
        history: [
          unpublished({ siteName: "first draft" }),
          unpublished({ siteName: "second draft" }),
        ],
        row: "G6 restoring a draft version onto the unpublished global keeps it unpublished",
        surfaces: ALL,
        target: 0,
      },
    ] satisfies {
      allowed: ActorName[];
      denied: ActorName[];
      draft: boolean;
      effect: Partial<Stored>;
      history: Step[];
      row: string;
      surfaces: Surface[];
      target: number;
    }[]),
  )("$row: $surface as $actor is $outcome", async (entry) => {
    const versionId = (await seedSettings(entry.history))[entry.target];
    if (versionId === undefined) {
      throw new Error(`history has no step ${entry.target}`);
    }
    await expectOutcome({
      attempt: () =>
        restoreSettings({
          actor: entry.actor,
          draft: entry.draft,
          surface: entry.surface,
          versionId,
        }),
      effect: entry.effect,
      outcome: entry.outcome,
      stored: storedSettings,
    });
  });

  // settingsFull holds every action a restore can need, so the lifecycle settles it without a
  // read; settingsPublisherVersions needs the stored state, so the lifecycle reads the version.
  test.each(["settingsFull", "settingsPublisherVersions"] satisfies ActorName[])(
    "restoring a missing version id as %s answers not found and writes nothing",
    async (actor) => {
      const [versionId] = await seedSettings([published({ siteName: "kept" })]);
      if (typeof versionId !== "number") {
        throw new Error("settings versions have numeric ids on SQLite");
      }
      const missingId = versionId + 1000;
      const before = await storedSettings();
      const { actor: user, token } = actorFor(actor);

      await rejectsWith(
        context.payload.restoreGlobalVersion({
          id: String(missingId),
          overrideAccess: false,
          slug: "settings",
          user,
        }),
        "NotFound",
      );
      const response = await rest(context, token)(
        "POST",
        `/globals/settings/versions/${missingId}`,
      );

      expect(response.status).toBe(404);
      expect(await storedSettings(), "a missing version writes nothing").toEqual(before);
    },
  );

  test.each(ALL)(
    "restore over %s without readVersions answers alike for a published, a draft and a missing version id",
    async (surface) => {
      const [publishedId, draftId] = await seedSettings([
        published({ siteName: "oracle live" }),
        { data: { siteName: "oracle pending" }, draft: true },
      ]);
      if (typeof publishedId !== "number" || typeof draftId !== "number") {
        throw new Error("settings versions have numeric ids on SQLite");
      }
      const missingId = draftId + 1000;
      const before = await storedSettings();
      const answers = await Promise.all(
        [publishedId, draftId, missingId].map((versionId) =>
          restoreSettings({ actor: "settingsNoVersions", draft: false, surface, versionId }),
        ),
      );
      expect(answers).toEqual(["forbidden", "forbidden", "forbidden"]);
      expect(await storedSettings(), "a denied restore writes nothing").toEqual(before);
    },
  );
});
