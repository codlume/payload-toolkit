import { type CollectionConfig, createLocalReq, type Payload, type PayloadRequest } from "payload";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, login, PASSWORD, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import {
  createTestPayload,
  defaultRolesOptions,
  fixtureCollections,
  type TestPayload,
} from "../../helpers/payload.ts";

type Id = number | string;
type Doc = Record<string, unknown>;

type Hook = "afterChange" | "beforeChange" | "beforeOperation" | "beforeValidate";

let armed: { hook: Hook; run: (req: PayloadRequest) => Promise<void> } | undefined;

const fire = async (hook: Hook, req: PayloadRequest) => {
  if (armed?.hook !== hook) {
    return;
  }
  const { run } = armed;
  armed = undefined;
  await run(req);
};

const settle = (promise: Promise<unknown>): Promise<PromiseSettledResult<unknown>> =>
  promise.then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ reason, status: "rejected" }),
  );

const during = async <T>(
  hook: Hook,
  effect: (req: PayloadRequest) => Promise<unknown>,
  outer: () => Promise<T>,
) => {
  const seen: { nested?: PromiseSettledResult<unknown> } = {};
  armed = {
    hook,
    run: async (req) => {
      seen.nested = await settle(effect(req));
    },
  };
  try {
    const outcome = await outer();
    return { nested: seen.nested, outcome };
  } finally {
    armed = undefined;
  }
};

const withAppHooks = (collection: CollectionConfig): CollectionConfig => {
  if (collection.slug === "pages") {
    return {
      ...collection,
      hooks: {
        beforeChange: [
          async ({ data, req }) => {
            await fire("beforeChange", req);
            return data;
          },
        ],
        beforeOperation: [
          async ({ req }) => {
            await fire("beforeOperation", req);
          },
        ],
        beforeValidate: [
          async ({ data, req }) => {
            await fire("beforeValidate", req);
            return data;
          },
        ],
      },
    };
  }
  if (collection.slug === "posts") {
    return {
      ...collection,
      hooks: {
        afterChange: [
          async ({ doc, req }) => {
            await fire("afterChange", req);
            return doc;
          },
        ],
      },
    };
  }
  return collection;
};

const openAccess = () => true;

const collections = (): CollectionConfig[] => [
  ...fixtureCollections().map(withAppHooks),
  {
    access: {
      create: openAccess,
      delete: openAccess,
      read: openAccess,
      readVersions: openAccess,
      update: openAccess,
    },
    fields: [{ name: "title", type: "text" }],
    slug: "articles",
    trash: true,
    versions: { drafts: true },
  },
  { auth: true, fields: [], slug: "editors" },
];

const rolesOptions = () => {
  const defaults = defaultRolesOptions();
  return { ...defaults, collections: [...(defaults.collections ?? []), "articles"] };
};

type State = "N" | "P" | "P+" | "PD" | "T";

// Payload orders versions by `updatedAt`. Two writes in one millisecond leave both versions marked
// latest, and a later non-draft edit of a PD document then keeps it published.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 2));

const docs = (payload: Payload) => {
  const seed = async (state: State, title: string, collection = "pages"): Promise<Id> => {
    const write = async <T>(run: () => Promise<T>) => {
      const result = await run();
      await nextMillisecond();
      return result;
    };
    if (state === "N") {
      const doc = await write(() =>
        payload.create({ collection, data: { _status: "draft", title }, draft: true }),
      );
      return doc.id;
    }
    const { id } = await write(() =>
      payload.create({ collection, data: { _status: "published", title } }),
    );
    if (state === "P+") {
      await write(() => payload.update({ collection, data: { title: `${title} edited` }, id }));
    }
    if (state === "PD") {
      await write(() =>
        payload.update({ collection, data: { title: `${title} pending` }, draft: true, id }),
      );
    }
    if (state === "T") {
      await write(() =>
        payload.update({ collection, data: { deletedAt: new Date().toISOString() }, id }),
      );
    }
    return id;
  };

  const stored = (id: Id, collection = "pages") =>
    payload.db.findOne({ collection, where: { id: { equals: id } } });

  const latestVersion = async (id: Id) => {
    const { docs: versions } = await payload.db.findVersions<Doc>({
      collection: "pages",
      limit: 1,
      pagination: false,
      sort: "-updatedAt",
      where: { and: [{ parent: { equals: id } }, { latest: { equals: true } }] },
    });
    return versions[0]?.version;
  };

  const versionOf = async (id: Id, title: string, collection = "pages"): Promise<string> => {
    const { docs: versions } = await payload.db.findVersions<Doc>({
      collection,
      limit: 1,
      pagination: false,
      where: { and: [{ parent: { equals: id } }, { "version.title": { equals: title } }] },
    });
    const version = versions[0];
    if (!version) {
      throw new Error(`no ${collection} version of ${String(id)} titled ${title}`);
    }
    const versionId: unknown = version.id;
    return String(versionId);
  };

  return { latestVersion, seed, stored, versionOf };
};

let context: TestPayload;
let pages: ReturnType<typeof docs>;
let users: Record<
  "bystander" | "postsWriter" | "superAdmin" | "unpublishOnly" | "updateOnly" | "versionEditor",
  Actor
>;
let roles: Record<"unpublishOnly" | "updateOnly", Id>;
let editorToken: string;
const tokens = new Map<string, string>();

const tokenOf = async (actor: Actor) => {
  const known = tokens.get(actor.email);
  if (known) {
    return known;
  }
  const token = await login(context.payload, actor.email);
  tokens.set(actor.email, token);
  return token;
};

beforeAll(async () => {
  context = await createTestPayload({
    collections: collections(),
    name: "lifecycle-isolation",
    roles: rolesOptions(),
  });
  const { payload } = context;
  pages = docs(payload);
  const superAdmin = await seedUser(payload, { email: "super@example.com" });
  const role = (key: string, permissions: Parameters<typeof seedRole>[2]) =>
    seedRole(payload, key, permissions);
  roles = {
    unpublishOnly: await role("unpublish-only", {
      collections: { pages: { actions: ["read", "unpublish"] } },
    }),
    updateOnly: await role("update-only", {
      collections: { pages: { actions: ["read", "update"] } },
    }),
  };
  const versionEditor = await role("version-editor", {
    collections: { pages: { actions: ["read", "update", "readVersions"] } },
  });
  const postsWriter = await role("posts-writer", {
    collections: { posts: { actions: ["read", "create", "update"] } },
  });
  users = {
    bystander: await seedUser(payload, { email: "bystander@example.com" }),
    postsWriter: await seedUser(payload, { email: "posts@example.com", roles: [postsWriter] }),
    superAdmin,
    unpublishOnly: await seedUser(payload, {
      email: "unpublish-only@example.com",
      roles: [roles.unpublishOnly],
    }),
    updateOnly: await seedUser(payload, {
      email: "update-only@example.com",
      roles: [roles.updateOnly],
    }),
    versionEditor: await seedUser(payload, {
      email: "version-editor@example.com",
      roles: [versionEditor],
    }),
  };

  await payload.create({
    collection: "editors",
    data: { email: "editor@example.com", password: PASSWORD },
  });
  const session = await payload.login({
    collection: "editors",
    data: { email: "editor@example.com", password: PASSWORD },
  });
  if (!session.token) {
    throw new Error("editor login returned no token");
  }
  editorToken = session.token;
});

afterAll(() => context.destroy());

type Transport = "Local" | "REST" | "trusted";

type Attempt =
  | { kind: "restore"; versionId: Id }
  | { kind: "update"; id: Id; data: Doc; draft?: boolean };

const attempt = async (
  transport: Transport,
  actor: Actor,
  request: Attempt,
): Promise<"allowed" | "denied"> => {
  const { payload } = context;
  if (transport === "REST") {
    const call = rest(context, await tokenOf(actor));
    const response =
      request.kind === "update"
        ? await call(
            "PATCH",
            `/pages/${request.id}${request.draft ? "?draft=true" : ""}`,
            request.data,
          )
        : await call("POST", `/pages/versions/${request.versionId}`);
    if (response.status === 200) {
      return "allowed";
    }
    if (response.status === 403) {
      return "denied";
    }
    throw new Error(`unexpected REST ${response.status}: ${JSON.stringify(response.json)}`);
  }
  const access =
    transport === "Local"
      ? { overrideAccess: false, user: actor }
      : { req: await createLocalReq({ user: actor }, payload) };
  try {
    await (request.kind === "update"
      ? payload.update({
          collection: "pages",
          data: request.data,
          draft: request.draft ?? false,
          id: request.id,
          ...access,
        })
      : payload.restoreVersion({ collection: "pages", id: String(request.versionId), ...access }));
    return "allowed";
  } catch (error) {
    if (error instanceof Error && error.name === "Forbidden") {
      return "denied";
    }
    throw error;
  }
};

const NESTED = { _status: "published", title: "nested" };
const MISSING_ID = 987_654;

type Scene = { req: PayloadRequest; actor: Actor; other: Id; third: Id };

type Effect = {
  name: string;
  run: (scene: Scene) => Promise<unknown>;
  nested: Doc;
  publishesOther: boolean;
  /**
   * Under an untrusted member write on pages, a trusted write to any page is judged as the
   * member's: the outer id can name that page in another form or be rewritten by an app hook,
   * so the operation scope cannot rule it out. These members lack publish, so it is refused.
   */
  underMember?: { nested: Doc; publishesOther: boolean };
};

const trustedPublishOther = ({ req, other }: Scene) =>
  context.payload.update({ collection: "pages", data: NESTED, id: other, req });

const untrustedPublishThird = ({ req, actor, third }: Scene) =>
  context.payload.update({
    collection: "pages",
    data: { _status: "published", title: "untrusted" },
    id: third,
    overrideAccess: false,
    req,
    user: actor,
  });

const effects: Effect[] = [
  {
    name: "a trusted publish of another page",
    nested: { status: "fulfilled" },
    publishesOther: true,
    underMember: {
      nested: { reason: { name: "Forbidden" }, status: "rejected" },
      publishesOther: false,
    },
    run: trustedPublishOther,
  },
  {
    name: "a trusted find",
    nested: { status: "fulfilled" },
    publishesOther: false,
    run: ({ req }) => context.payload.find({ collection: "pages", req }),
  },
  {
    name: "a caught trusted update of a missing page",
    nested: { reason: { name: "NotFound" }, status: "rejected" },
    publishesOther: false,
    underMember: {
      nested: { reason: { name: "Forbidden" }, status: "rejected" },
      publishesOther: false,
    },
    run: ({ req }) =>
      context.payload.update({
        collection: "pages",
        data: { _status: "published" },
        id: MISSING_ID,
        req,
      }),
  },
  {
    name: "a caught trusted update that fails validation",
    nested: { reason: { name: "ValidationError" }, status: "rejected" },
    publishesOther: false,
    run: ({ req }) =>
      context.payload.update({
        collection: "users",
        data: { email: "not-an-email" },
        id: users.bystander.id,
        req,
      }),
  },
  {
    name: "a trusted and an untrusted publish side by side on the shared req",
    nested: {
      status: "fulfilled",
      value: [{ status: "fulfilled" }, { reason: { name: "Forbidden" }, status: "rejected" }],
    },
    publishesOther: true,
    underMember: {
      nested: {
        status: "fulfilled",
        value: [
          { reason: { name: "Forbidden" }, status: "rejected" },
          { reason: { name: "Forbidden" }, status: "rejected" },
        ],
      },
      publishesOther: false,
    },
    run: (scene) =>
      Promise.all([settle(trustedPublishOther(scene)), settle(untrustedPublishThird(scene))]),
  },
  {
    name: "an untrusted and a trusted publish side by side on the shared req",
    nested: {
      status: "fulfilled",
      value: [{ reason: { name: "Forbidden" }, status: "rejected" }, { status: "fulfilled" }],
    },
    publishesOther: true,
    underMember: {
      nested: {
        status: "fulfilled",
        value: [
          { reason: { name: "Forbidden" }, status: "rejected" },
          { reason: { name: "Forbidden" }, status: "rejected" },
        ],
      },
      publishesOther: false,
    },
    run: (scene) =>
      Promise.all([settle(untrustedPublishThird(scene)), settle(trustedPublishOther(scene))]),
  },
];

type Outer = {
  name: string;
  actor: "updateOnly" | "versionEditor";
  transports: Transport[];
  seed: () => Promise<{ self: Id; request: Attempt }>;
  outcome: "allowed" | "denied";
  stored: Doc;
  version?: string;
};

const outers: Outer[] = [
  {
    actor: "updateOnly",
    name: "an update-only user publishing a draft page",
    outcome: "denied",
    seed: async () => {
      const self = await pages.seed("N", "self");
      return {
        request: { data: { _status: "published", title: "outer" }, id: self, kind: "update" },
        self,
      };
    },
    stored: { _status: "draft", title: "self" },
    transports: ["REST", "Local"],
  },
  {
    actor: "updateOnly",
    name: "an update-only user saving a draft of a published page",
    outcome: "allowed",
    seed: async () => {
      const self = await pages.seed("P", "self");
      return {
        request: { data: { title: "outer draft" }, draft: true, id: self, kind: "update" },
        self,
      };
    },
    stored: { _status: "published", title: "self" },
    transports: ["REST", "Local"],
    version: "outer draft",
  },
  {
    actor: "updateOnly",
    name: "a trusted edit carrying the update-only user",
    outcome: "allowed",
    seed: async () => {
      const self = await pages.seed("N", "self");
      return { request: { data: { title: "outer trusted" }, id: self, kind: "update" }, self };
    },
    stored: { _status: "draft", title: "outer trusted" },
    transports: ["trusted"],
  },
  {
    actor: "versionEditor",
    name: "a version editor without publish restoring a published version",
    outcome: "denied",
    seed: async () => {
      const self = await pages.seed("P+", "self");
      return { request: { kind: "restore", versionId: await pages.versionOf(self, "self") }, self };
    },
    stored: { _status: "published", title: "self edited" },
    transports: ["REST", "Local"],
  },
  {
    actor: "versionEditor",
    name: "a version editor restoring a draft version onto a draft page",
    outcome: "allowed",
    seed: async () => {
      const self = await pages.seed("N", "self");
      await context.payload.update({
        collection: "pages",
        data: { title: "self v2" },
        draft: true,
        id: self,
      });
      return {
        request: { kind: "restore", versionId: await pages.versionOf(self, "self v2") },
        self,
      };
    },
    stored: { _status: "draft", title: "self v2" },
    transports: ["REST", "Local"],
  },
];

const pageHooks = ["beforeOperation", "beforeValidate", "beforeChange"] as const;

const matrix = outers.flatMap((outer) =>
  outer.transports.flatMap((transport) =>
    pageHooks.flatMap((hook) =>
      effects.map((effect) => ({
        effect,
        hook,
        outer,
        title: `${outer.name} over ${transport}, with ${effect.name} in an app ${hook} hook`,
        transport,
      })),
    ),
  ),
);

describe("nested calls from app hooks never carry trust into the operation around them", () => {
  for (const { effect, hook, outer, title, transport } of matrix) {
    test(title, async () => {
      const other = await pages.seed("N", "other");
      const third = await pages.seed("N", "third");
      const actor = users[outer.actor];
      const { self, request } = await outer.seed();

      const { nested, outcome } = await during(
        hook,
        (req) => effect.run({ actor, other, req, third }),
        () => attempt(transport, actor, request),
      );

      expect(outcome, "the outer operation is decided by its own user and transition").toBe(
        outer.outcome,
      );
      expect(
        await pages.stored(self),
        "the outer page holds exactly the outer decision",
      ).toMatchObject(outer.stored);
      if (outer.version) {
        expect(
          await pages.latestVersion(self),
          "the draft save is stored as a version",
        ).toMatchObject({ title: outer.version });
      }
      if (hook === "beforeOperation" || outer.outcome === "allowed") {
        expect(nested, `the app ${hook} hook ran its nested call`).toBeDefined();
      }
      const expected = transport !== "trusted" && effect.underMember ? effect.underMember : effect;
      if (nested) {
        expect(nested, "the nested calls get their own decisions").toMatchObject(expected.nested);
      }
      expect(
        await pages.stored(other),
        "a nested trusted publish that ran is stored even when the outer write is denied",
      ).toMatchObject(
        nested && expected.publishesOther ? NESTED : { _status: "draft", title: "other" },
      );
      expect(
        await pages.stored(third),
        "an untrusted nested publish on the shared req is never stored",
      ).toMatchObject({ _status: "draft", title: "third" });
    });
  }
});

for (const transport of ["REST", "Local"] as const) {
  for (const hook of pageHooks) {
    test(`an update-only ${transport} publish stays denied when an app ${hook} hook publishes the same page with trust, which is refused too`, async () => {
      const self = await pages.seed("N", "self");

      const { nested, outcome } = await during(
        hook,
        (req) => context.payload.update({ collection: "pages", data: NESTED, id: self, req }),
        () =>
          attempt(transport, users.updateOnly, {
            data: { _status: "published", title: "outer" },
            id: self,
            kind: "update",
          }),
      );

      expect(outcome, "the update-only user cannot publish").toBe("denied");
      if (hook === "beforeOperation") {
        expect(nested, "beforeOperation app hooks run before any access decision").toBeDefined();
      }
      if (nested) {
        expect(
          nested,
          "a trusted write to the document an untrusted write names is judged as the member's",
        ).toMatchObject({ reason: { name: "Forbidden" }, status: "rejected" });
      }
      expect(
        await pages.stored(self),
        "the page holds neither the outer write nor the refused nested publish",
      ).toMatchObject({ _status: "draft", title: "self" });
    });
  }
}

test("concurrent Local writes from different users and trusted calls each get their own decision", async () => {
  const { payload } = context;
  const seedMany = (count: number, state: State, prefix: string, roleId: Id) =>
    Promise.all(
      Array.from({ length: count }, async (_, index) => {
        const title = `${prefix} ${index}`;
        return {
          actor: await seedUser(payload, {
            email: `${prefix}-${index}@example.com`,
            roles: [roleId],
          }),
          id: await pages.seed(state, title),
          title,
        };
      }),
    );
  const unpublishers = await seedMany(4, "P", "unpublisher", roles.unpublishOnly);
  const publishers = await seedMany(4, "N", "publisher", roles.updateOnly);
  const trusted = await seedMany(2, "N", "trusted", roles.updateOnly);

  const runs = [
    ...unpublishers.map(({ actor, id, title }) => ({
      expected: { outcome: "allowed", stored: { _status: "draft", title } },
      id,
      run: () => attempt("Local", actor, { data: { _status: "draft" }, id, kind: "update" }),
    })),
    ...publishers.map(({ actor, id, title }) => ({
      expected: { outcome: "denied", stored: { _status: "draft", title } },
      id,
      run: () =>
        attempt("Local", actor, {
          data: { _status: "published", title: "stolen" },
          id,
          kind: "update",
        }),
    })),
    ...trusted.map(({ actor, id }) => ({
      expected: { outcome: "allowed", stored: { _status: "published", title: "trusted publish" } },
      id,
      run: () =>
        attempt("trusted", actor, {
          data: { _status: "published", title: "trusted publish" },
          id,
          kind: "update",
        }),
    })),
  ];
  const outcomes = await Promise.all(runs.map(({ run }) => run()));
  const observed = await Promise.all(
    runs.map(async ({ id }, index) => ({
      outcome: outcomes[index],
      stored: await pages.stored(id),
    })),
  );

  expect(
    observed,
    "unpublish-only users unpublish, update-only users cannot publish, trusted calls publish",
  ).toMatchObject(runs.map(({ expected }) => expected));
});

test("a trusted Local call from an app hook in a REST request writes pages the REST user holds no grants for", async () => {
  const { payload } = context;
  const draft = await pages.seed("N", "sync draft");
  const live = await pages.seed("P", "sync live");
  const bin = await pages.seed("P", "sync bin");
  const writer = rest(context, await tokenOf(users.postsWriter));

  expect(
    (await writer("PATCH", `/pages/${draft}`, { _status: "published", title: "direct" })).status,
    "the posts writer holds no pages grants",
  ).toBe(403);

  const { nested, outcome } = await during(
    "afterChange",
    async (req) => {
      await payload.update({
        collection: "pages",
        data: { _status: "published", title: "synced" },
        id: draft,
        req,
      });
      await payload.update({ collection: "pages", data: { _status: "draft" }, id: live, req });
      await payload.update({
        collection: "pages",
        data: { deletedAt: new Date().toISOString() },
        id: bin,
        req,
      });
    },
    () => writer("POST", "/posts", { title: "sync" }),
  );

  expect(outcome.status, "the posts write itself is allowed").toBe(201);
  expect(nested, "the app hook's trusted pages writes succeed").toMatchObject({
    status: "fulfilled",
  });
  expect(await pages.stored(draft)).toMatchObject({ _status: "published", title: "synced" });
  expect(await pages.stored(live)).toMatchObject({ _status: "draft", title: "sync live" });
  expect(await pages.stored(bin)).toMatchObject({ deletedAt: expect.any(String) });
});

type Transition = {
  name: string;
  from: State;
  rest: (args: { collection: string; id: Id; versionOf: Versions }) => Promise<RestCall>;
  trusted: (args: {
    collection: string;
    id: Id;
    payload: Payload;
    versionOf: Versions;
  }) => Promise<unknown>;
  stored: Doc;
};

type Versions = ReturnType<typeof docs>["versionOf"];
type RestCall = [method: string, path: string, body?: Doc];

const restoreFromTrash = { _status: "draft", deletedAt: null };

const transitions: Transition[] = [
  {
    from: "P",
    name: "save a draft of a published document",
    rest: async ({ collection, id }) => [
      "PATCH",
      `/${collection}/${id}?draft=true`,
      { title: "changed" },
    ],
    stored: { _status: "published", title: "seed" },
    trusted: ({ collection, id, payload }) =>
      payload.update({ collection, data: { title: "changed" }, draft: true, id }),
  },
  {
    from: "N",
    name: "publish a draft document",
    rest: async ({ collection, id }) => [
      "PATCH",
      `/${collection}/${id}`,
      { _status: "published", title: "changed" },
    ],
    stored: { _status: "published", title: "changed" },
    trusted: ({ collection, id, payload }) =>
      payload.update({ collection, data: { _status: "published", title: "changed" }, id }),
  },
  {
    from: "P",
    name: "unpublish a published document",
    rest: async ({ collection, id }) => ["PATCH", `/${collection}/${id}`, { _status: "draft" }],
    stored: { _status: "draft", title: "seed" },
    trusted: ({ collection, id, payload }) =>
      payload.update({ collection, data: { _status: "draft" }, id }),
  },
  {
    from: "PD",
    name: "unpublish implicitly by a non-draft edit over a pending draft",
    rest: async ({ collection, id }) => ["PATCH", `/${collection}/${id}`, { title: "changed" }],
    stored: { _status: "draft", title: "changed" },
    trusted: ({ collection, id, payload }) =>
      payload.update({ collection, data: { title: "changed" }, id }),
  },
  {
    from: "P",
    name: "move a published document to the trash",
    rest: async ({ collection, id }) => [
      "PATCH",
      `/${collection}/${id}`,
      { deletedAt: new Date().toISOString() },
    ],
    stored: { deletedAt: expect.any(String) },
    trusted: ({ collection, id, payload }) =>
      payload.update({ collection, data: { deletedAt: new Date().toISOString() }, id }),
  },
  {
    from: "T",
    name: "restore a document from the trash",
    rest: async ({ collection, id }) => [
      "PATCH",
      `/${collection}?trash=true&where[id][equals]=${id}`,
      restoreFromTrash,
    ],
    stored: restoreFromTrash,
    trusted: ({ collection, id, payload }) =>
      payload.update({
        collection,
        data: restoreFromTrash,
        trash: true,
        where: { id: { equals: id } },
      }),
  },
  {
    from: "P+",
    name: "restore an earlier published version",
    rest: async ({ collection, id, versionOf }) => [
      "POST",
      `/${collection}/versions/${await versionOf(id, "seed", collection)}`,
    ],
    stored: { _status: "published", title: "seed" },
    trusted: async ({ collection, id, payload, versionOf }) =>
      payload.restoreVersion({ collection, id: await versionOf(id, "seed", collection) }),
  },
];

const overREST = async (
  target: TestPayload,
  token: null | string,
  collection: string,
  transition: Transition,
) => {
  const helpers = docs(target.payload);
  const id = await helpers.seed(transition.from, "seed", collection);
  const [method, path, body] = await transition.rest({
    collection,
    id,
    versionOf: helpers.versionOf,
  });
  const response = await rest(target, token)(method, path, body);
  return { status: response.status, stored: await helpers.stored(id, collection) };
};

describe("exemptions: lifecycle never adds a denial", () => {
  for (const transition of transitions) {
    test(`a user of another auth collection may ${transition.name} on pages`, async () => {
      expect(await overREST(context, editorToken, "pages", transition)).toMatchObject({
        status: 200,
        stored: transition.stored,
      });
    });
  }

  for (const transition of transitions) {
    test(`an anonymous request may ${transition.name} where app access allows it`, async () => {
      expect(await overREST(context, null, "articles", transition)).toMatchObject({
        status: 200,
        stored: transition.stored,
      });
    });
  }

  for (const transition of transitions) {
    test(`a super admin may ${transition.name} on pages`, async () => {
      expect(
        await overREST(context, await tokenOf(users.superAdmin), "pages", transition),
      ).toMatchObject({ status: 200, stored: transition.stored });
    });
  }

  for (const transition of transitions) {
    test(`a trusted Local API call may ${transition.name}`, async () => {
      const { payload } = context;
      const id = await pages.seed(transition.from, "seed");
      await transition.trusted({ collection: "pages", id, payload, versionOf: pages.versionOf });
      expect(await pages.stored(id)).toMatchObject(transition.stored);
    });
  }

  test("an anonymous request gets the app's denial on pages, and nothing is stored", async () => {
    const id = await pages.seed("N", "anonymous target");
    const anonymous = rest(context, null);

    expect(
      (await anonymous("PATCH", `/pages/${id}`, { _status: "published", title: "anonymous" }))
        .status,
    ).toBe(403);
    expect(
      (await anonymous("POST", "/pages", { _status: "published", title: "anonymous" })).status,
    ).toBe(403);

    expect(await pages.stored(id)).toMatchObject({ _status: "draft", title: "anonymous target" });
    expect(
      await context.payload.db.findOne({
        collection: "pages",
        where: { title: { equals: "anonymous" } },
      }),
      "no anonymous page was created",
    ).toBeNull();
  });

  test("a super admin still gets the app's update denial on notes", async () => {
    const note = await context.payload.create({ collection: "notes", data: { title: "kept" } });
    const superAdmin = rest(context, await tokenOf(users.superAdmin));

    expect((await superAdmin("PATCH", `/notes/${note.id}`, { title: "changed" })).status).toBe(403);
    expect(
      await context.payload.db.findOne({ collection: "notes", where: { id: { equals: note.id } } }),
    ).toMatchObject({ title: "kept" });
  });

  test("enforcing mode does not warn that lifecycle enforcement is missing", () => {
    expect(context.logs).not.toContainEqual(
      expect.objectContaining({ event: "lifecycle_not_installed" }),
    );
  });
});

describe("disabled mode", () => {
  let disabled: TestPayload;
  let token: string;

  beforeAll(async () => {
    disabled = await createTestPayload({
      name: "lifecycle-disabled",
      roles: { ...defaultRolesOptions(), enabled: false },
    });
    await seedUser(disabled.payload, { email: "super@example.com" });
    const nobody = await seedUser(disabled.payload, { email: "nobody@example.com" });
    token = await login(disabled.payload, nobody.email);
  });

  afterAll(() => disabled.destroy());

  test("keeps the roles schema and warns that enforcement is disabled", () => {
    expect(disabled.payload.collections.roles, "the roles collection still exists").toBeDefined();
    expect(disabled.logs).toContainEqual(
      expect.objectContaining({ event: "enforcement_disabled", plugin: "roles" }),
    );
  });

  for (const transition of transitions) {
    test(`a user with no role may ${transition.name}, as app access allows`, async () => {
      expect(await overREST(disabled, token, "pages", transition)).toMatchObject({
        status: 200,
        stored: transition.stored,
      });
    });
  }
});
