import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { type Actor, as, login, rest, seedRole, seedUser } from "../../helpers/actors.ts";
import { createTestPayload, type TestPayload } from "../../helpers/payload.ts";

const ROLES = {
  createOnly: ["read", "create"],
  createPublish: ["read", "create", "update", "publish"],
  unpublishOnly: ["read", "unpublish"],
  updateOnly: ["read", "update"],
  updatePublish: ["read", "update", "publish"],
  updateUnpublish: ["read", "update", "unpublish"],
} satisfies Record<string, string[]>;

type Role = keyof typeof ROLES;
type Id = number | string;
type Data = Record<string, unknown>;
type State = "N" | "P" | "PD";
type Stored = { _status: unknown; title: unknown };
type Outcome = "allowed" | "forbidden" | `unexpected ${string}`;

type Write =
  | { kind: "create"; data: Data; draft: boolean }
  | { kind: "duplicate"; draft: boolean; id: Id }
  | { kind: "update"; data: Data; id: Id; via: "autosave" | "bulk" | "direct" | "draft" };

type Transport = (role: Role, write: Write) => Promise<Outcome>;

type Expectation = { allowed: Role[]; denied: Role[] };

type CreateRow = Expectation & {
  row: string;
  label: string;
  write: Omit<Extract<Write, { kind: "create" }>, "kind">;
  stores: Stored["_status"];
};

type DuplicateRow = Expectation & {
  row: string;
  label: string;
  draft: boolean;
  copyStatus: Stored["_status"];
};

type UpdateRow = Expectation & {
  row: string;
  label: string;
  from: State;
  write: Omit<Extract<Write, { kind: "update" }>, "id" | "kind">;
  effect: { main: Stored } | { version: Stored };
};

const STATUS = "_status";
const ORIGINAL = "original";
const PENDING = "pending";
const EDITED = "edited";

const draftVersion = { version: { _status: "draft", title: EDITED } };

const creates: CreateRow[] = [
  {
    allowed: ["createOnly"],
    denied: ["unpublishOnly"],
    label: "with _status draft",
    row: "C1",
    stores: "draft",
    write: { data: { _status: "draft" }, draft: false },
  },
  {
    allowed: ["createOnly"],
    denied: ["unpublishOnly"],
    label: "without _status",
    row: "C1",
    stores: "draft",
    write: { data: {}, draft: false },
  },
  {
    allowed: ["createOnly"],
    denied: ["unpublishOnly"],
    label: "with the draft flag",
    row: "C1",
    stores: "draft",
    write: { data: {}, draft: true },
  },
  {
    allowed: ["createPublish"],
    denied: ["createOnly"],
    label: "published",
    row: "C2",
    stores: "published",
    write: { data: { _status: "published" }, draft: false },
  },
];

const duplicates: DuplicateRow[] = [
  {
    allowed: ["createPublish"],
    copyStatus: "published",
    denied: ["createOnly"],
    draft: false,
    label: "non-draft duplicate of a published page",
    row: "C3",
  },
  {
    allowed: ["createOnly"],
    copyStatus: "draft",
    denied: [],
    draft: true,
    label: "draft duplicate of a published page",
    row: "C4",
  },
];

const saveDraft = (from: State): UpdateRow => ({
  allowed: ["updateOnly", "updatePublish"],
  denied: ["unpublishOnly"],
  effect: draftVersion,
  from,
  label: "save draft",
  row: "U1",
  write: { data: { title: EDITED }, via: "draft" },
});

const updates: UpdateRow[] = [
  saveDraft("N"),
  saveDraft("P"),
  saveDraft("PD"),
  {
    allowed: ["updateOnly"],
    denied: ["unpublishOnly"],
    effect: draftVersion,
    from: "P",
    label: "save draft with _status draft",
    row: "U1",
    write: { data: { _status: "draft", title: EDITED }, via: "draft" },
  },
  {
    allowed: ["updateOnly"],
    denied: ["unpublishOnly"],
    effect: draftVersion,
    from: "P",
    label: "autosave",
    row: "U1",
    write: { data: { title: EDITED }, via: "autosave" },
  },
  {
    allowed: ["updateOnly"],
    denied: ["unpublishOnly"],
    effect: draftVersion,
    from: "PD",
    label: "autosave",
    row: "U1",
    write: { data: { title: EDITED }, via: "autosave" },
  },
  {
    allowed: ["updatePublish"],
    denied: ["updateOnly", "unpublishOnly"],
    effect: { main: { _status: "published", title: EDITED } },
    from: "N",
    label: "publish",
    row: "U2",
    write: { data: { _status: "published", title: EDITED }, via: "direct" },
  },
  {
    allowed: ["updatePublish"],
    denied: ["updateOnly", "unpublishOnly"],
    effect: { main: { _status: "published", title: EDITED } },
    from: "PD",
    label: "publish",
    row: "U2",
    write: { data: { _status: "published", title: EDITED }, via: "direct" },
  },
  {
    allowed: ["updatePublish"],
    denied: ["updateOnly"],
    effect: { main: { _status: "published", title: EDITED } },
    from: "PD",
    label: "publish with the draft flag",
    row: "U2",
    write: { data: { _status: "published", title: EDITED }, via: "draft" },
  },
  {
    allowed: ["updatePublish"],
    denied: ["updateOnly", "unpublishOnly", "updateUnpublish"],
    effect: { main: { _status: "published", title: EDITED } },
    from: "P",
    label: "non-draft content edit",
    row: "U3",
    write: { data: { title: EDITED }, via: "direct" },
  },
  {
    allowed: ["unpublishOnly"],
    denied: ["updateOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: ORIGINAL } },
    from: "P",
    label: "status-only unpublish",
    row: "U4",
    write: { data: { _status: "draft" }, via: "direct" },
  },
  {
    allowed: ["unpublishOnly"],
    denied: ["updateOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: PENDING } },
    from: "PD",
    label: "status-only unpublish",
    row: "U4",
    write: { data: { _status: "draft" }, via: "direct" },
  },
  {
    allowed: ["updateUnpublish"],
    denied: ["unpublishOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: EDITED } },
    from: "P",
    label: "content-bearing unpublish",
    row: "U5",
    write: { data: { _status: "draft", title: EDITED }, via: "direct" },
  },
  {
    allowed: ["updateUnpublish"],
    denied: ["unpublishOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: EDITED } },
    from: "PD",
    label: "content-bearing unpublish",
    row: "U5",
    write: { data: { _status: "draft", title: EDITED }, via: "direct" },
  },
  {
    allowed: ["updateUnpublish"],
    denied: ["unpublishOnly", "updateOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: PENDING } },
    from: "PD",
    label: "implicit unpublish with an empty body",
    row: "U6",
    write: { data: {}, via: "direct" },
  },
  {
    allowed: ["updateUnpublish"],
    denied: ["unpublishOnly", "updateOnly", "updatePublish"],
    effect: { main: { _status: "draft", title: EDITED } },
    from: "PD",
    label: "implicit unpublish with a title",
    row: "U6",
    write: { data: { title: EDITED }, via: "direct" },
  },
  {
    allowed: ["updateOnly"],
    denied: ["unpublishOnly"],
    effect: { main: { _status: "draft", title: ORIGINAL } },
    from: "N",
    label: "non-draft status-only save",
    row: "U7",
    write: { data: { _status: "draft" }, via: "direct" },
  },
  {
    allowed: ["updatePublish"],
    denied: [],
    effect: { main: { _status: "published", title: EDITED } },
    from: "PD",
    label: "bulk non-draft content edit",
    row: "U8",
    write: { data: { title: EDITED }, via: "bulk" },
  },
];

let context: TestPayload;
let signedIn: Record<Role, { actor: Actor; token: string }>;

beforeAll(async () => {
  context = await createTestPayload({ name: "lifecycle-collections" });
  const { payload } = context;
  await seedUser(payload, { email: "bootstrap@example.com" });
  const signIn = async (name: Role) => {
    const key = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
    const role = await seedRole(payload, key, { collections: { pages: { actions: ROLES[name] } } });
    const actor = await seedUser(payload, { email: `${key}@example.com`, roles: [role] });
    return { actor, token: await login(payload, actor.email) };
  };
  signedIn = {
    createOnly: await signIn("createOnly"),
    createPublish: await signIn("createPublish"),
    unpublishOnly: await signIn("unpublishOnly"),
    updateOnly: await signIn("updateOnly"),
    updatePublish: await signIn("updatePublish"),
    updateUnpublish: await signIn("updateUnpublish"),
  };
});

afterAll(() => context.destroy());

let serial = 0;
const uniqueTitle = (row: string) => `${row} #${(serial += 1)}`;

const pick = (row: Data | null | undefined): Stored | null =>
  row ? { _status: row[STATUS], title: row.title } : null;

const mainRow = async (id: Id) =>
  pick(await context.payload.db.findOne({ collection: "pages", where: { id: { equals: id } } }));

const latestVersion = async (id: Id) => {
  const { docs } = await context.payload.db.findVersions({
    collection: "pages",
    limit: 1,
    pagination: false,
    sort: "-updatedAt",
    where: { and: [{ parent: { equals: id } }, { latest: { equals: true } }] },
  });
  return pick(docs[0]?.version);
};

const rowsTitled = async (title: string) => {
  const { docs } = await context.payload.db.find({
    collection: "pages",
    pagination: false,
    where: { title: { equals: title } },
  });
  return docs;
};

// The SQLite adapter clears `latest` only on versions with an older `updatedAt`, so two versions
// written in one millisecond both stay latest and Payload may read the wrong one as current.
const outlastNewestVersion = async (id: Id) => {
  const { docs } = await context.payload.db.findVersions({
    collection: "pages",
    limit: 1,
    pagination: false,
    sort: "-updatedAt",
    where: { parent: { equals: id } },
  });
  const wait = Date.parse(docs[0]?.updatedAt ?? "") + 2 - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
};

const seedPage = async (state: State, title = ORIGINAL) => {
  const { payload } = context;
  const page = await payload.create({
    collection: "pages",
    data: { _status: state === "N" ? "draft" : "published", title },
  });
  await outlastNewestVersion(page.id);
  if (state === "PD") {
    await payload.update({
      collection: "pages",
      data: { title: PENDING },
      draft: true,
      id: page.id,
    });
    await outlastNewestVersion(page.id);
  }
  return page.id;
};

const viaLocal: Transport = async (role, write) => {
  const api = as(context.payload, signedIn[role].actor);
  try {
    switch (write.kind) {
      case "create":
        await api.create({
          collection: "pages",
          data: write.data,
          ...(write.draft && { draft: true }),
        });
        break;
      case "duplicate":
        await api.duplicate({
          collection: "pages",
          id: write.id,
          ...(write.draft && { draft: true }),
        });
        break;
      case "update": {
        if (write.via === "bulk") {
          const { errors } = await api.updateMany({
            collection: "pages",
            data: write.data,
            where: { id: { equals: write.id } },
          });
          return errors.length === 0 ? "allowed" : `unexpected errors ${JSON.stringify(errors)}`;
        }
        const options = {
          autosave: write.via === "autosave",
          collection: "pages",
          data: write.data,
          draft: write.via !== "direct",
          id: write.id,
        };
        await api.update(options);
        break;
      }
      default: {
        const exhaustive: never = write;
        return exhaustive;
      }
    }
    return "allowed";
  } catch (error) {
    if (error instanceof Error && error.name === "Forbidden") {
      return "forbidden";
    }
    return `unexpected ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`;
  }
};

const updateQuery = { autosave: "?draft=true&autosave=true", direct: "", draft: "?draft=true" };

const viaRest: Transport = async (role, write) => {
  const call = rest(context, signedIn[role].token);
  const response = await (() => {
    switch (write.kind) {
      case "create":
        return call("POST", `/pages${write.draft ? "?draft=true" : ""}`, write.data);
      case "duplicate":
        return call("POST", `/pages/${write.id}/duplicate${write.draft ? "" : "?draft=false"}`);
      case "update":
        return write.via === "bulk"
          ? call("PATCH", `/pages?where[id][equals]=${write.id}`, write.data)
          : call("PATCH", `/pages/${write.id}${updateQuery[write.via]}`, write.data);
      default: {
        const exhaustive: never = write;
        return exhaustive;
      }
    }
  })();
  const errors = response.json?.errors;
  if (response.status < 300 && (!Array.isArray(errors) || errors.length === 0)) {
    return "allowed";
  }
  if (response.status === 403) {
    return "forbidden";
  }
  return `unexpected ${response.status} ${JSON.stringify(response.json)}`;
};

const transports = { Local: viaLocal, REST: viaRest } satisfies Record<string, Transport>;

const verdicts = ({ allowed, denied }: Expectation) => [
  ...allowed.map((role) => ({ allowed: true, role })),
  ...denied.map((role) => ({ allowed: false, role })),
];

const verdict = (allowed: boolean) => (allowed ? "allowed" : "denied");

for (const [transport, run] of Object.entries(transports)) {
  describe(transport, () => {
    for (const row of creates) {
      for (const { allowed, role } of verdicts(row)) {
        test(`${row.row} create ${row.label} as ${role} is ${verdict(allowed)}`, async () => {
          const title = uniqueTitle(row.row);
          const outcome = await run(role, {
            data: { ...row.write.data, title },
            draft: row.write.draft,
            kind: "create",
          });

          expect(outcome, "request outcome").toBe(allowed ? "allowed" : "forbidden");
          expect((await rowsTitled(title)).map(pick), "stored rows").toEqual(
            allowed ? [{ _status: row.stores, title }] : [],
          );
        });
      }
    }

    for (const row of duplicates) {
      for (const { allowed, role } of verdicts(row)) {
        test(`${row.row} ${row.label} as ${role} is ${verdict(allowed)}`, async () => {
          const title = uniqueTitle(row.row);
          const id = await seedPage("P", title);
          const outcome = await run(role, { draft: row.draft, id, kind: "duplicate" });

          expect(outcome, "request outcome").toBe(allowed ? "allowed" : "forbidden");
          const copies = (await rowsTitled(title)).filter((doc) => doc.id !== id);
          expect(copies.map(pick), "stored copies").toEqual(
            allowed ? [{ _status: row.copyStatus, title }] : [],
          );
          expect(await mainRow(id), "source row").toEqual({ _status: "published", title });
        });
      }
    }

    for (const row of updates) {
      for (const { allowed, role } of verdicts(row)) {
        test(`${row.row} ${row.label} from ${row.from} as ${role} is ${verdict(allowed)}`, async () => {
          const id = await seedPage(row.from);
          const before = { main: await mainRow(id), version: await latestVersion(id) };
          const outcome = await run(role, { ...row.write, id, kind: "update" });

          expect(outcome, "request outcome").toBe(allowed ? "allowed" : "forbidden");
          const after = { main: await mainRow(id), version: await latestVersion(id) };
          if (!allowed) {
            expect(after, "stored main row and latest version unchanged").toEqual(before);
          } else if ("main" in row.effect) {
            expect(after.main, "stored main row").toEqual(row.effect.main);
          } else {
            expect(after.main, "stored main row unchanged").toEqual(before.main);
            expect(after.version, "latest version").toEqual(row.effect.version);
          }
        });
      }
    }
  });
}
