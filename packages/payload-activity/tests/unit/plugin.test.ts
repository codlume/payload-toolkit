import { sqliteAdapter } from "@payloadcms/db-sqlite";
import { buildConfig, type Config, type FieldHook, type Plugin } from "payload";
import { describe, expect, expectTypeOf, test, vi } from "vitest";

import { activityPlugin, type ActivityPluginOptions } from "@codlume/payload-activity";

const createSourceConfig = () =>
  ({
    admin: { user: "users" },
    collections: [
      { auth: true, fields: [], slug: "users" },
      { fields: [], slug: "posts" },
      { fields: [], slug: "pages" },
    ],
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    globals: [
      { fields: [], slug: "site-settings" },
      { fields: [], slug: "navigation" },
    ],
    secret: "activity-unit-test-secret",
  }) satisfies Config;

type ActivityFieldTarget = {
  entityType: "collection" | "global";
  slug: string;
};

const defaultActivityTarget = { entityType: "collection", slug: "posts" } as const;

const getActivityField = async (
  options: ActivityPluginOptions = { collections: ["posts"] },
  target: ActivityFieldTarget = defaultActivityTarget,
) => {
  const transformed = await activityPlugin(options)(createSourceConfig());
  const targets =
    target.entityType === "collection" ? transformed.collections : transformed.globals;
  const field = targets
    ?.find(({ slug }) => slug === target.slug)
    ?.fields.find((candidate) => "name" in candidate && candidate.name === "lastModifiedBy");

  if (!field || field.type !== "relationship") {
    throw new TypeError(`Expected ${target.slug} to have the Activity relationship field`);
  }

  return field;
};

const getActivityHook = async (
  options?: ActivityPluginOptions,
  target: ActivityFieldTarget = defaultActivityTarget,
): Promise<FieldHook> => {
  const field = await getActivityField(options, target);
  const hook = field.hooks?.beforeChange?.[0];

  if (!hook) {
    throw new TypeError("Expected the Activity field to have a beforeChange hook");
  }

  return hook;
};

const invokeActivityHook = async ({
  debug,
  operation,
  options,
  previousValue,
  target,
  user,
}: {
  debug: (entry: unknown) => unknown;
  operation: "create" | "update";
  options: ActivityPluginOptions;
  previousValue: number | undefined;
  target: ActivityFieldTarget;
  user: { collection: string; id?: number | string } | undefined;
}) => {
  const hook = await getActivityHook(options, target);

  return Reflect.apply(hook, undefined, [
    {
      collection: target.entityType === "collection" ? { slug: target.slug } : null,
      global: target.entityType === "global" ? { slug: target.slug } : null,
      operation,
      previousValue,
      req: { payload: { logger: { debug } }, user },
    },
  ]);
};

const buildPayloadConfig = (
  collections: NonNullable<Config["collections"]>,
  plugins: Plugin[],
  adminUser?: string,
) =>
  buildConfig({
    ...(adminUser === undefined ? {} : { admin: { user: adminUser } }),
    collections,
    db: sqliteAdapter({ client: { url: ":memory:" } }),
    plugins,
    secret: "activity-unit-test-secret",
  });

describe("activityPlugin", () => {
  test("requires at least one configured target", () => {
    expectTypeOf<{}>().not.toMatchTypeOf<ActivityPluginOptions>();
  });

  test("accepts global strings before generated types exist", () => {
    expectTypeOf<{ globals: ["not-yet-generated"] }>().toMatchTypeOf<ActivityPluginOptions>();
  });

  test("accepts collection strings before generated types exist", () => {
    expectTypeOf<{ collections: ["not-yet-generated"] }>().toMatchTypeOf<ActivityPluginOptions>();
  });

  test("adds the last-modified relationship to configured collections only", async () => {
    const sourceConfig = createSourceConfig();

    const transformed = await activityPlugin({ collections: ["posts"] })(sourceConfig);

    expect(
      transformed.collections?.map((collection) => ({
        fields: collection.fields.flatMap((field) =>
          "name" in field
            ? [{ name: field.name, relationTo: Reflect.get(field, "relationTo") }]
            : [],
        ),
        slug: collection.slug,
      })),
    ).toEqual([
      { fields: [], slug: "users" },
      { fields: [{ name: "lastModifiedBy", relationTo: "users" }], slug: "posts" },
      { fields: [], slug: "pages" },
    ]);
  });

  test("adds the last-modified relationship to configured globals only", async () => {
    const transformed = await activityPlugin({ globals: ["site-settings"] })(createSourceConfig());

    expect(
      transformed.globals?.map((global) => ({
        fields: global.fields.flatMap((field) =>
          "name" in field
            ? [{ name: field.name, relationTo: Reflect.get(field, "relationTo") }]
            : [],
        ),
        slug: global.slug,
      })),
    ).toEqual([
      {
        fields: [{ name: "lastModifiedBy", relationTo: "users" }],
        slug: "site-settings",
      },
      { fields: [], slug: "navigation" },
    ]);
  });

  test("uses a custom field name and accepts debug mode", async () => {
    const transformed = await activityPlugin({
      collections: ["posts"],
      debug: true,
      fieldName: "editedBy",
    })(createSourceConfig());
    const fieldNames = transformed.collections
      ?.find(({ slug }) => slug === "posts")
      ?.fields.flatMap((field) => ("name" in field ? [field.name] : []));

    expect(fieldNames).toEqual(["editedBy"]);
  });

  test("injects a nullable read-only sidebar relationship owned by the plugin", async () => {
    const field = await getActivityField();
    const createAccess = field.access?.create;
    const updateAccess = field.access?.update;

    if (!createAccess || !updateAccess) {
      throw new TypeError("Expected the Activity field to deny caller writes");
    }

    expect({
      admin: field.admin,
      createAllowed: Reflect.apply(createAccess, undefined, [{}]),
      localized: field.localized,
      relationTo: field.relationTo,
      required: field.required,
      type: field.type,
      updateAllowed: Reflect.apply(updateAccess, undefined, [{}]),
    }).toEqual({
      admin: {
        position: "sidebar",
        readOnly: true,
      },
      createAllowed: false,
      localized: false,
      relationTo: "users",
      required: false,
      type: "relationship",
      updateAllowed: false,
    });
  });

  test.each([
    ["admin user", { collection: "users", id: 42 }, 42],
    ["admin user without an ID", { collection: "users" }, null],
    ["foreign auth user", { collection: "customers", id: 21 }, null],
    ["no user", undefined, null],
  ])("attributes an edit from %s", async (_label, user, expected) => {
    const hook = await getActivityHook();

    const result = Reflect.apply(hook, undefined, [
      { previousValue: 7, req: { user }, value: "caller-supplied" },
    ]);

    expect(result).toBe(expected);
  });

  test("logs an attributed collection edit when debug diagnostics are enabled", async () => {
    const debug = vi.fn();
    await invokeActivityHook({
      debug,
      operation: "update",
      options: { collections: ["posts"], debug: true },
      previousValue: undefined,
      target: defaultActivityTarget,
      user: { collection: "users", id: 42 },
    });

    expect(debug.mock.calls).toEqual([
      [
        {
          entityType: "collection",
          event: "attribution_applied",
          operation: "update",
          plugin: "activity",
          slug: "posts",
          userId: 42,
        },
      ],
    ]);
  });

  test("logs why an unattributed global edit has no user", async () => {
    const debug = vi.fn();
    await invokeActivityHook({
      debug,
      operation: "update",
      options: { debug: true, globals: ["site-settings"] },
      previousValue: undefined,
      target: { entityType: "global", slug: "site-settings" },
      user: undefined,
    });

    expect(debug.mock.calls).toEqual([
      [
        {
          entityType: "global",
          event: "attribution_cleared",
          operation: "update",
          plugin: "activity",
          reason: "no_user",
          slug: "site-settings",
        },
      ],
    ]);
  });

  test("logs why an edit from another auth collection is cleared", async () => {
    const debug = vi.fn();
    await invokeActivityHook({
      debug,
      operation: "create",
      options: { collections: ["posts"], debug: true },
      previousValue: undefined,
      target: defaultActivityTarget,
      user: { collection: "customers", id: 21 },
    });

    expect(debug.mock.calls).toEqual([
      [
        {
          entityType: "collection",
          event: "attribution_cleared",
          operation: "create",
          plugin: "activity",
          reason: "foreign_auth_collection",
          slug: "posts",
        },
      ],
    ]);
  });

  const silentDiagnosticModes = [
    ["debug diagnostics are disabled", { debug: false }],
    ["attribution is disabled", { debug: true, enabled: false }],
  ] satisfies [string, Pick<ActivityPluginOptions, "debug" | "enabled">][];

  test.each(silentDiagnosticModes)("does not log when %s", async (_label, mode) => {
    const debug = vi.fn();
    await invokeActivityHook({
      debug,
      operation: "update",
      options: { collections: ["posts"], ...mode },
      previousValue: 7,
      target: defaultActivityTarget,
      user: { collection: "users", id: 42 },
    });

    expect(debug).not.toHaveBeenCalled();
  });

  test("keeps attribution working when the host logger throws", async () => {
    const result = await invokeActivityHook({
      debug: () => {
        throw new Error("logger unavailable");
      },
      operation: "update",
      options: { collections: ["posts"], debug: true },
      previousValue: undefined,
      target: defaultActivityTarget,
      user: { collection: "users", id: 42 },
    });

    expect(result).toBe(42);
  });

  test("keeps the field hidden and preserves its value while disabled", async () => {
    const options = { collections: ["posts"], enabled: false } satisfies ActivityPluginOptions;
    const field = await getActivityField(options);
    const hook = await getActivityHook(options);

    expect({
      admin: field.admin,
      existing: Reflect.apply(hook, undefined, [
        { previousValue: 12, req: { user: { collection: "users", id: 42 } } },
      ]),
      newDocument: Reflect.apply(hook, undefined, [
        { previousValue: undefined, req: { user: { collection: "users", id: 42 } } },
      ]),
    }).toEqual({
      admin: {
        hidden: true,
        position: "sidebar",
        readOnly: true,
      },
      existing: 12,
      newDocument: null,
    });
  });

  test("reports deterministic configuration problems together", async () => {
    const options = {
      collections: ["posts", "posts", "missing"],
      fieldName: "updatedAt",
    } satisfies ActivityPluginOptions;
    const firstPlugin = activityPlugin(options);
    const secondPlugin = activityPlugin({ collections: ["posts"] });

    await expect(
      buildPayloadConfig(
        [
          { auth: true, fields: [], slug: "users" },
          { fields: [{ name: "updatedAt", type: "text" }], slug: "posts" },
        ],
        [firstPlugin, secondPlugin],
      ),
    ).rejects.toMatchObject({
      message: [
        "Invalid Activity plugin configuration:",
        '- `collections` must not contain duplicate slug "posts".',
        '- `fieldName` "updatedAt" is reserved by Payload; choose a plugin-owned field name.',
        "- Register `activityPlugin` only once; found 2 registrations.",
        '- Collection "posts" already has a top-level data-bearing field named "updatedAt".',
        '- Collection "missing" does not exist.',
      ].join("\n"),
      name: "ActivityPluginConfigError",
    });
  });

  test("reports global target problems together", async () => {
    await expect(
      buildConfig({
        collections: [{ auth: true, fields: [], slug: "users" }],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        globals: [
          {
            fields: [{ name: "lastModifiedBy", type: "text" }],
            slug: "site-settings",
          },
        ],
        plugins: [
          activityPlugin({
            globals: ["site-settings", "site-settings", "missing"],
          }),
        ],
        secret: "activity-unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message: [
        "Invalid Activity plugin configuration:",
        '- `globals` must not contain duplicate slug "site-settings".',
        '- Global "site-settings" already has a top-level data-bearing field named "lastModifiedBy".',
        '- Global "missing" does not exist.',
      ].join("\n"),
      name: "ActivityPluginConfigError",
    });
  });

  test("rejects an empty collections array", async () => {
    await expect(
      buildPayloadConfig(
        [
          { auth: true, fields: [], slug: "users" },
          { fields: [], slug: "posts" },
        ],
        [activityPlugin({ collections: [] })],
      ),
    ).rejects.toMatchObject({
      message:
        "Invalid Activity plugin configuration:\n- `collections` must be a non-empty array of collection slugs.",
      name: "ActivityPluginConfigError",
    });
  });

  test.each(["_activity.value", "9activity", "updatedAt"])(
    "rejects unsafe or reserved field name %s",
    async (fieldName) => {
      await expect(
        buildPayloadConfig(
          [
            { auth: true, fields: [], slug: "users" },
            { fields: [], slug: "posts" },
          ],
          [activityPlugin({ collections: ["posts"], fieldName })],
        ),
      ).rejects.toMatchObject({ name: "ActivityPluginConfigError" });
    },
  );

  test("resolves a custom auth-enabled admin user collection", async () => {
    const config = await buildPayloadConfig(
      [
        { auth: true, fields: [], slug: "admins" },
        { fields: [], slug: "posts" },
      ],
      [activityPlugin({ collections: ["posts"] })],
      "admins",
    );
    const field = config.collections
      .find(({ slug }) => slug === "posts")
      ?.fields.find((candidate) => "name" in candidate && candidate.name === "lastModifiedBy");

    expect(field && "relationTo" in field ? field.relationTo : undefined).toBe("admins");
  });

  test.each([
    [[{ fields: [], slug: "posts" }], 'Admin user collection "users" does not exist.'],
    [
      [
        { fields: [], slug: "users" },
        { fields: [], slug: "posts" },
      ],
      'Admin user collection "users" must be auth-enabled.',
    ],
  ] satisfies [NonNullable<Config["collections"]>, string][])(
    "rejects an invalid admin user collection: %s",
    async (collections, problem) => {
      await expect(
        buildPayloadConfig(collections, [activityPlugin({ collections: ["posts"] })]),
      ).rejects.toMatchObject({
        message: `Invalid Activity plugin configuration:\n- ${problem}`,
        name: "ActivityPluginConfigError",
      });
    },
  );

  test("detects fields hoisted through layout fields but allows the same nested group key", async () => {
    await expect(
      buildPayloadConfig(
        [
          { auth: true, fields: [], slug: "users" },
          {
            fields: [
              {
                fields: [{ name: "lastModifiedBy", type: "text" }],
                type: "row",
              },
            ],
            slug: "posts",
          },
        ],
        [activityPlugin({ collections: ["posts"] })],
      ),
    ).rejects.toMatchObject({ name: "ActivityPluginConfigError" });

    await expect(
      buildPayloadConfig(
        [
          { auth: true, fields: [], slug: "users" },
          {
            fields: [
              {
                fields: [{ name: "lastModifiedBy", type: "text" }],
                name: "metadata",
                type: "group",
              },
            ],
            slug: "posts",
          },
        ],
        [activityPlugin({ collections: ["posts"] })],
      ),
    ).resolves.toBeDefined();
  });

  test.each(["collection", "hash", "password"])(
    "reports collisions with Payload-generated auth field %s",
    async (fieldName) => {
      await expect(
        buildPayloadConfig(
          [
            { auth: true, fields: [], slug: "users" },
            { auth: true, fields: [], slug: "members" },
          ],
          [activityPlugin({ collections: ["members"], fieldName })],
        ),
      ).rejects.toMatchObject({
        message: [
          "Invalid Activity plugin configuration:",
          `- Collection "members" reserves the top-level field "${fieldName}" for Payload authentication.`,
        ].join("\n"),
        name: "ActivityPluginConfigError",
      });
    },
  );

  test("reports collisions with Payload's configured folder field", async () => {
    await expect(
      buildConfig({
        collections: [
          { auth: true, fields: [], slug: "users" },
          { fields: [], folders: true, slug: "posts" },
        ],
        db: sqliteAdapter({ client: { url: ":memory:" } }),
        folders: { fieldName: "parentFolder" },
        plugins: [activityPlugin({ collections: ["posts"], fieldName: "parentFolder" })],
        secret: "activity-unit-test-secret",
      }),
    ).rejects.toMatchObject({
      message: [
        "Invalid Activity plugin configuration:",
        '- Collection "posts" reserves the top-level field "parentFolder" for Payload folders.',
      ].join("\n"),
      name: "ActivityPluginConfigError",
    });
  });

  test("leaves the source collections unchanged", async () => {
    const sourceConfig = createSourceConfig();

    await activityPlugin({ collections: ["posts"] })(sourceConfig);

    expect(sourceConfig.collections?.map(({ fields }) => fields)).toEqual([[], [], []]);
  });
});
