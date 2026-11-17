# Admin shell and sign-in

The demo app in `apps/payload-cms` serves Payload Admin at `/admin` with the Media, Users, and Pages collections and the Site Settings global. An editor signs in and reaches every plugin feature from here.

## Sub-features

- `shell-first-user` creates the first admin on an empty database.
- `shell-login` signs in with email and password.
- `shell-nav` lists Media, Users, Pages, and Site Settings in the sidebar.
- `shell-modes` starts in each `PAYLOAD_APP_MODE` (`enabled-in-memory`, `disabled-in-memory`, `enabled-temporary-file`).

## How to get to it (user POV)

- Open `<origin>/admin` on an empty database. Payload redirects to `/admin/create-first-user`.
- Open `<origin>/admin/login` and sign in.
- Choose a collection or global from the sidebar.

## Driving it with the browser tool and verify.mjs

Preconditions:

- `verify launch` finished. It already created the first user through `POST /api/users/first-register`, so `shell-first-user` is covered by its `verify: ready` line.

- **Sign in.** Open `<origin>/admin/login`, fill `#field-email` with `verify@example.com` and `#field-password` with `verify-password`, and press Enter. The URL becomes `<origin>/admin` and the links `Media`, `Users`, `Pages`, and `Site Settings` appear.
- **First-user form.** To prove the form itself, run `verify launch --no-seed` and open `<origin>/admin`. It redirects to `/admin/create-first-user`, with `Email`, `Password`, `Confirm Password`, and `Name` fields. `Name` is required by the demo Users collection. With `--no-seed`, `verify api` cannot log in until you create `verify@example.com` / `verify-password` in that form.
- **Modes.** Run `verify launch --mode disabled-in-memory`. Admin loads and the media edit view has no BlurHash panel. `verify launch` rejects an unknown `--mode` before it starts anything.
- **Proof.** Screenshot the dashboard after sign-in.

## Gotchas

- The first `/admin` request compiles about 3,700 modules and takes 1 to 2 minutes. Later pages compile on first visit too. Wait for text, not for a fixed time.
- Open the app at `localhost`, the origin that `launch` configures. Signing in at `127.0.0.1` works but breaks live preview.
- `server.log` shows `No email adapter provided`. That warning is expected.
