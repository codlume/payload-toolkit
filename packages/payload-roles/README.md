# Payload Roles

Database-backed roles for Payload CMS. Editors manage roles in the admin panel. Each role grants
actions on the collections and globals you list. The plugin intersects those grants with the access
functions your app already has, so a role can narrow access and never widen it.

This package is in development. It is private, unpublished, and its API can change.

## Installation

```sh
pnpm add @codlume/payload-roles
```

## Compatibility

- Payload >=3.90.1 <4. Use the latest 3.x release; the 3.93.0 release notes list security fixes.
- Node >=22.12.0 <23 or >=24.0.0 <25
- Payload's SQLite, Postgres and MongoDB adapters. The core test suites run on SQLite only; see
  [Limitations](#limitations).

## Configuration

Register the plugin once and list the collections and globals it manages. The roles collection
is always managed. The admin user collection is managed only when you list it.

```ts
import { rolesPlugin } from "@codlume/payload-roles";
import { buildConfig } from "payload";

export default buildConfig({
  collections: [
    { auth: true, fields: [], slug: "users" },
    { fields: [], slug: "pages", versions: { drafts: true } },
  ],
  globals: [{ fields: [], slug: "settings" }],
  plugins: [
    rolesPlugin({
      collections: ["users", "pages"],
      globals: ["settings"],
    }),
  ],
});
```

| Option            | Type               | Default                         |
| ----------------- | ------------------ | ------------------------------- |
| `collections`     | `CollectionSlug[]` | No collections                  |
| `globals`         | `GlobalSlug[]`     | No globals                      |
| `userCollection`  | `CollectionSlug`   | Payload's admin user collection |
| `rolesSlug`       | `string`           | `"roles"`                       |
| `rolesField`      | `string`           | `"roles"`                       |
| `superAdminField` | `string`           | `"superAdmin"`                  |
| `enabled`         | `boolean`          | `true`                          |
| `debug`           | `boolean`          | `false`                         |

Configuration errors are reported together at startup as one `RolesPluginConfigError`. The plugin
rejects missing targets, unknown or duplicate slugs, Payload system collections, a user collection
that is not auth-enabled, field names that clash on the user collection, a `rolesSlug` that is
already a collection, collections that use `versions.drafts.localizeStatus`, a user collection
with `versions.drafts`, and a second registration. Startup also fails when a plugin that runs after this one changes the drafts, trash,
versions or auth shape of a managed collection, or removes one of the plugin's own hooks.

Hooks that Payload or a later plugin adds after this plugin runs, such as the `beforeChange` hook
Payload adds to orderable collections, do not stop startup. At startup, before and after your
`onInit`, the plugin moves its own hooks back to the front of `beforeOperation` and the end of the
other hook lists, so its checks always judge the data those hooks produce.

### What the plugin adds

- A `roles` collection with `key` (unique, kebab-case, fixed after create), `name`, `description`
  and a `permissions` JSON field shaped as
  `{ collections: { [slug]: { actions: ActionId[] } }, globals: { [slug]: { actions: ActionId[] } } }`.
  Versions are kept for audit.
- On the user collection: a `roles` relationship (`hasMany`, `maxDepth: 0`, not saved to the JWT), a
  `superAdmin` checkbox, and a hidden unique `rolesBootstrapClaim` field that the bootstrap uses.
- On managed collections and globals, admin document controls listed after the app's own
  `beforeDocumentControls`. A component the app already set in an edit slot, such as its own
  `UnpublishButton`, keeps that slot and its own gating.

Actions are `read`, `create`, `update`, `delete`, `trash`, `publish`, `unpublish`, `readVersions`
and `unlock`. An action applies to a resource only when the config supports it: `trash` needs
`trash: true`, `publish` and `unpublish` need drafts, `readVersions` needs versions, `unlock` needs
an auth collection with login attempts, and globals have no `create`, `delete` or `trash`. Granting
`publish` requires `update` on the same resource. Saving a role with a cell that does not apply, is
unknown, or that the editor does not hold fails with a field error on that cell.

## What core enforces

For every managed collection and global, each access function becomes `roles AND app`. The roles
side is a set lookup after one role query per request. The app side is your access function, or
Payload's default when you have none. A missing app function still requires a logged-in user, so a
grant never makes a resource public.

| Roles side | App side | Result            |
| ---------- | -------- | ----------------- |
| false      | any      | false             |
| true       | any      | the app's result  |
| `Where`    | true     | the roles `Where` |
| `Where`    | `Where`  | `{ and: [...] }`  |

A falsy app result, such as `undefined` from a JavaScript access function, counts as `false`, as it
does for Payload itself, so it cannot widen the roles `Where`.

Capabilities come from the user's roles, loaded by id on every request and unioned. A user with
`superAdmin: true` passes the roles side for everything; app access still applies. A user with no
roles, a dangling role id, or malformed `permissions` JSON gets nothing from that role. A resolver
error grants nothing to every request that shared the lookup and logs once at error level.
Capabilities are memoized on the request's user object for five seconds. REST, GraphQL and the
admin panel load a fresh user for every request, so a change to a user or to a role lands on that
user's next request.

The roles collection is readable and writable only by signed-in users of the user collection.
Anonymous callers and users of other auth collections get Payload's own access answer, a 403, and
never reach the guards below.

The user collection and the roles collection carry extra guards. They run in Payload's
`beforeChange` and `beforeDelete` hooks, after Payload's own access check and query validation,
once for each document a write touches. A guard reads its target as a stored database row, never
through `afterRead` hooks, and judges the privileged keys as the client sent them together with
the data Payload is about to write. The plugin never runs a client's `where` itself.

- `superAdmin` must be sent as a boolean and `roles` as an array of role ids. Any other shape, such
  as the string `"true"`, a single id, or a populated object, is a `ValidationError` on that
  field, because Payload would otherwise coerce it after the guards had run.
- Only a super admin may set or change `superAdmin`. The last active super admin cannot be
  demoted, trashed or deleted, by anyone. A super admin already in the trash does not count, so
  they can be deleted for good while another super admin remains.
- Assigning roles needs `update` on users, and every role added or removed must be within the
  editor's own capabilities. Nobody except a super admin changes their own roles.
- Creating a user follows the same rules, so a users-creator cannot mint an account more capable
  than themselves. A duplicate is judged on the merged document Payload is about to create, after
  Payload's field access ran on it.
- Restoring a version of a user or a role runs the same checks against the values Payload is
  about to write, so an old version cannot bring back a role, a credential or a permission the
  editor could not grant directly. Payload's field access runs first and drops what the editor
  may not write, such as `superAdmin` for a non-super-admin, so such a restore goes through
  without that value. A restore that app code runs with `overrideAccess: true` on an HTTP
  request's `req` skips field access, so there the guard also compares `hash`, `salt`,
  `lockUntil`, `loginAttempts` and `sessions`.
- Changing another user's `password`, `hash`, `salt`, `email`, `username`, `apiKey`,
  `enableAPIKey`, `lockUntil`, `loginAttempts`, `sessions` or `deletedAt` is refused when that
  user is a super admin or holds a capability the editor lacks. Comparison is by value, so
  re-submitting an unchanged form passes. Users may always change their own credentials.
- On a user collection with `auth.verify`, setting another user's `_verified` to anything but
  `true` follows the same rule, because Payload refuses login to an unverified user. Setting it
  to `true` is never refused, so Payload's first-register can verify the first user.
- Bulk updates and bulk deletes are judged one document at a time, the way Payload runs them.
  Documents the editor may change go through; each refused document is listed in the response's
  `errors` (HTTP 400 over REST). A bulk that would demote, trash or delete every super admin is
  refused for the last one.
- Deleting users needs the editor to cover every target. Trash and permanent delete follow the
  same rule. A bulk delete is judged on the users Payload selects, so users in the trash count
  only when the request sets `trash=true`.
- A role can be created or changed only within the editor's capabilities. Its `key` is fixed after
  creation. Stored permissions are canonical.
- Changing, restoring or deleting a role, by id or in bulk, also needs the editor to hold every
  action the role grants now. Otherwise an editor could weaken a stronger user's role and then
  change that user's password. Super admins are exempt.

A refused guard throws Payload's `Forbidden` (HTTP 403). Cell errors throw a `ValidationError`
(HTTP 400) whose paths point at `permissions.<collections|globals>.<slug>.actions`.

A user without `read` on the user collection can still read and update their own document, so
`/users/me` and the account page work. Because that is a `Where`, the Users item appears in the
admin navigation for every signed-in user even when the list is empty for them.

### Bootstrap

A user created while the user collection is empty becomes a super admin. This applies again if
every user is ever removed, so on an app with public signup the next signup after that becomes a
super admin. The claim is written on a hidden unique column in the same insert, so two concurrent
first registrations cannot both win: the unique index rejects the second. The first-register endpoint cannot carry `superAdmin` or `roles`; those bodies are
refused. Later seeds set `superAdmin: true` over the Local API.

## Interim: lifecycle not installed

Core does not yet classify what a write does. Until the lifecycle module ships, the plugin demands
every action a write could possibly need, so `publish`, `unpublish`, `trash` and `readVersions`
never allow a write on their own and the stock admin buttons stay honest. Startup logs
`lifecycle_not_installed` to say so.

| Write                                               | Requires                                                     |
| --------------------------------------------------- | ------------------------------------------------------------ |
| Create on a drafts resource with `_status: "draft"` | `create`                                                     |
| Any other create on a drafts resource               | `create`, `publish`                                          |
| Any update on a drafts resource                     | `update`, `publish`, `unpublish`                             |
| Update whose body has `deletedAt` (trash, restore)  | the above plus `trash`                                       |
| Body with only `_status` (stock Unpublish, restore) | the above plus `readVersions` when the resource has versions |
| Restore a version                                   | `update`, `publish`, `unpublish`, `readVersions`             |
| Permanent delete                                    | `delete`                                                     |
| Delete access with `deletedAt` set                  | `trash`                                                      |
| Read versions                                       | `readVersions`                                               |
| Global write on a drafts global                     | `update`, `publish`, `unpublish`                             |

The cost is that a role with `update` alone cannot save a draft on a drafts collection, and a role
with `unpublish` alone cannot unpublish. Grant the full set for now.

## Trusted boundaries

- Local API calls default to `overrideAccess: true`. They skip access functions and the guards.
  The guards on users and roles treat a write as trusted only when `overrideAccess` is `true`
  and the request originated in-process (`req.payloadAPI === "local"`). The lifecycle module
  states its own rule.
- A Local API call that passes an HTTP request's `req` keeps that request's origin. The guards then
  judge the body by `req.user`, so app code that sets `superAdmin` or `roles` on behalf of an HTTP
  request needs that request's user to be a super admin.
- Plugin-internal reads go through `payload.db` with the request, so they stay inside the
  request's transaction, run no hooks and no access control, and never run a client's `where`.
- Jobs queued without a user run trusted. `schedulePublish` reloads the queuing user and is judged
  as that user.
- Anonymous requests and users from other auth collections are outsiders. The plugin returns the
  app's access result unchanged for them, except that the user and roles guards treat an outsider
  as holding nothing, so a public signup cannot carry `roles` or `superAdmin`.

## Disabled mode

`enabled: false` keeps the roles collection and the user fields, logs `enforcement_disabled` at
startup, and composes nothing. App access decides alone, which is fail-open. The `roles` and
`superAdmin` fields carry no plugin access rules either, so whoever the app lets update a user can
set them, and the guards do not run. The roles collection still admits only signed-in users of the
user collection. The bootstrap still runs so the first user can administer roles once enforcement
is turned on. The admin document controls are left as the app configured them.

## Debug diagnostics

Set `debug: true` to log `access_denied`, `guard_denied`, `permissions_dropped` and
`bootstrap_claimed` events at debug level through Payload's logger. Every entry carries
`plugin: "roles"`. Warnings and errors are logged regardless of `debug`.

## Limitations

- Role and last-super-admin checks read, decide and then write. They are not atomic under
  concurrent writes on SQLite, on Postgres, and on MongoDB without a replica set. Two concurrent
  demotions can leave no super admin; a grant revoked mid-request still applies to that request.
  Sequential requests are exact.
- The plugin passes `req` to its reads. On SQLite, do not set `transactionOptions`; Payload's
  SQLite transaction path fails under concurrent writers (`SQLITE_BUSY`).
- On MongoDB the plugin awaits the user model's index build at startup so the bootstrap claim's
  unique index exists before traffic. This is inferred from Mongoose's behavior and was not run
  against MongoDB in this repository.
- Field-level access on `roles` and `superAdmin` only drives the admin UI's read-only state. The
  guards are the authority.
- Drafts on the user collection are not supported, and startup rejects them. Payload's duplicate
  and publish start from the latest draft, while the guards judge the stored user.
- The plugin reads `superAdmin` and the role ids from the user object on the request and never
  reloads them. Only the grants of those roles are reloaded, at most five seconds after they
  change. Local API code that keeps a user object and passes it as `user` therefore keeps that
  user's `superAdmin` flag and role ids for as long as it holds the object. Load the user again
  after you change their roles or `superAdmin`.
- The core test suites run on SQLite only. Payload's Postgres and MongoDB adapters are supported,
  and some feasibility gates ran on them, but the guards and the bootstrap were not run against
  them in this repository.
- The plugin's own `beforeOperation` hook runs first on the user and roles collections, ahead of
  every app hook. Payload awaits each `beforeOperation` hook in turn, so an app hook there whose
  `AsyncLocalStorage.enterWith` must reach the operation's later hooks no longer does. Pass such
  state between hooks through Payload's `req.context` instead.
- Hook order is restored at startup only. Payload's development hot reload rebuilds hook lists
  without running `onInit`, a process that skips `onInit` never restores them, and app code that
  adds a hook to a live hook list after startup puts it after the plugin's checks. In each case a
  hook added after the plugin's own runs after its checks, and an id it rewrites there is not
  judged. Register hooks in the Payload config.
- An app hook that starts another write on the same collection under the same request, for
  example an exported operation called with `disableTransaction: true` or a Local API call that
  passes `req`, from any hook including `afterChange`, makes writes that untrusted records cover
  count as untrusted. The guards then judge them with the editor's grants, and the lifecycle
  module refuses them. A trusted write from app code inside an editor's write therefore needs its
  own Local API request without `req`.
- Operations started synchronously from app code, without an `await` between them, stack their
  records in one async context. From about the 64th of them (the 63rd on Node 22) every later
  write in that context is untrusted: the guards judge it with the editor's grants and the
  lifecycle module refuses it. The records stay in memory until the context ends.
- On an upload-enabled user collection, an update that replaces the file writes the new file and
  deletes the old one before `beforeChange` runs (gate G18). A refused update can therefore leave
  the stored row pointing at a file that no longer exists. The plugin does not handle this.

## Development

Run the repository validation gates from the workspace root with `pnpm ready`.

## License

MIT. See [LICENSE](LICENSE).
