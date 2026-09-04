# Setup

Open-Bugster is one container and one data volume. From nothing to a working board is one command and a couple of minutes. This document covers the whole installation; the README has the short version.

## Using it

**You need** Docker on the machine that will host it, and, only if you want to import TestFlight feedback, an App Store Connect API key (see [app-store-connect.md](app-store-connect.md)), or, for issues from Jira Cloud, an Atlassian API token (see [jira.md](jira.md)). The board works fine without either.

1. **Get the code.**

   ```bash
   git clone https://github.com/Roeselmann/open-bugster.git
   cd open-bugster
   ```

2. **Start it, saying who the first account is.** The email becomes your sign-in name and the owner of the instance; the password needs at least 12 characters.

   ```bash
   APP_ADMIN_EMAIL=ada@example.com APP_ADMIN_PASSWORD='a-long-password' docker compose up --build -d
   ```

   The first start creates the database, a default board, and your owner account, and generates the two machine secrets (the session-cookie key and the encryption key for stored App Store Connect keys) into the data volume. The bootstrap variables are read exactly once; the password is hashed immediately and never stored in plain text.

3. **Sign in** at `http://<host>:3000` with that email and password. From here on the database is the only source of truth: the bootstrap variables are never read again, and passwords are changed in the app.

4. **Set up the board.** Rename it, adjust its lanes, and, if you have an API key, enter the credentials under **Board settings → TestFlight** or **Board settings → Jira**, press **Test connection**, then the sync button in the header.

5. **Invite your team.** **Users** in the account menu creates an account and shows a one-time link to pass on. Then add them to the board under **Board settings → Users**, as viewer, editor, or administrator.

### Configuring through `.env` instead

Everything above can also live in a file, which is the better home for the optional settings anyway:

```bash
cp .env.example .env
```

Fill in `APP_ADMIN_EMAIL`, `APP_ADMIN_PASSWORD`, and, if you like, the first and last name, then start with a plain `docker compose up --build -d`. Two substitutions are available for the cautious:

- **No plain password, even once:** hash it yourself and set `APP_PASSWORD_HASH` instead of `APP_ADMIN_PASSWORD` (the hash wins if both are set). `npm run password:hash -- "your-secure-password"` prints the line to copy into `.env` unchanged; the single quotes protect the `$` characters. It needs Node.js 22 or newer but no `npm install`; with Docker only, `docker compose run --rm bugster npm run password:hash -- "your-secure-password"` does the same inside the container.
- **Secrets under your own management:** set `NUXT_SESSION_PASSWORD` and `BUGSTER_SECRET_KEY` (generate each with `openssl rand -base64 32`). Whatever you set in the environment wins over the generated values in the volume; whatever you leave empty keeps generating itself.

### After the first start

Behind an HTTPS reverse proxy, set `NUXT_SESSION_COOKIE_SECURE=true` in `.env` and restart.

Data lives in the named volume `bugster-data`, mounted at `/data`. It survives restarts, image rebuilds, and `docker compose down`, but not `docker compose down -v`. The generated secrets sit in `secrets.json` inside that same volume, so a volume backup is self-contained; if you keep a `.env`, back it up alongside. Without the original `BUGSTER_SECRET_KEY`, wherever it lives, the stored App Store Connect keys cannot be decrypted again.

Updating is `scripts/update.sh`, which pulls, takes a backup, and rebuilds in one go; schema changes are applied automatically on start. See [backups-and-updates.md](backups-and-updates.md).

### Where data lives

Open-Bugster needs no database server. All structured data is one SQLite file, and uploaded and imported files sit in a separate attachments directory.

| Setting | Purpose |
| --- | --- |
| `DATABASE_PATH` | Path to the SQLite file, for example `/data/open-bugster.sqlite` |
| `ATTACHMENTS_PATH` | Path to the attachments directory |

The two paths belong together: switch, copy, and back them up as one unit, and restart after changing `.env`. If the configured database does not exist, it is created on first access. An empty application therefore does not necessarily mean that data was deleted: `DATABASE_PATH` often points to a different, newly created file. Existing installations may continue to use a file named `bugster.sqlite`; no rename is required.

### If nobody can sign in

The owner is seeded from the bootstrap variables **only on the very first start**, and only when `APP_ADMIN_PASSWORD` (with at least 12 characters) or `APP_PASSWORD_HASH` is set. If both were missing, the database comes up with its default board but no account, and the login page rejects everything. The server log says so on every start:

```
[open-bugster] No account exists yet, so nobody can sign in: neither APP_ADMIN_PASSWORD nor APP_PASSWORD_HASH is set.
```

Because the seed never runs again once an account exists, a forgotten owner password cannot be fixed by editing `.env` either. Both cases are handled by the same command, run on the host that holds the database:

```bash
npm run owner:reset -- you@example.com "a-new-long-password"
```

It reads `DATABASE_PATH` from the environment or from `.env`, and then:

- **the address exists**: sets the new password, re-enables the account if it was disabled, and signs out every session it still had open;
- **there are no accounts at all**: creates that address as the **owner**, with administrator access to every existing board;
- **the address is unknown but others exist**: changes nothing and lists the addresses that do exist.

In Docker, run it inside the container so it sees the same volume:

```bash
docker compose exec bugster npm run owner:reset -- you@example.com "a-new-long-password"
```

## How it works

- **Bootstrap runs inside the first database migration.** `ensureUsers` seeds the owner when the users table is empty; `warnWhenNobodyCanSignIn` logs on every start until an account exists.
- **Secrets are generated before anything needs them.** The `00-runtime-secrets` plugin runs first, reads `NUXT_SESSION_PASSWORD` and `BUGSTER_SECRET_KEY`, and generates whatever is missing into `secrets.json` next to the database. An environment value is never copied into the file.
- **The image holds no state.** `Dockerfile` builds the Nuxt app; `docker-compose.yml` mounts the `bugster-data` volume at `/data` and reads `.env` at runtime.
- **The database is created on first access**, and schema changes are `ensure*` migrations that run inside `getDb()`; see [architecture.md](architecture.md#data-layer).

## Code map

| File | What lives there |
|---|---|
| `Dockerfile`, `docker-compose.yml` | The image and the one-service stack with its volume. |
| `.env.example` | Every variable with its explanation. |
| [server/utils/config.ts](../server/utils/config.ts) | Reads the bootstrap variables and the two paths. |
| [server/utils/runtime-secrets.ts](../server/utils/runtime-secrets.ts), [server/plugins/00-runtime-secrets.ts](../server/plugins/00-runtime-secrets.ts) | Secret generation and precedence. |
| [server/utils/db.ts](../server/utils/db.ts) | `getDb`, `ensureUsers`, `warnWhenNobodyCanSignIn`. |
| `scripts/hash-password.mjs` | `npm run password:hash`. |
| `scripts/reset-owner.mjs` | `npm run owner:reset`. |
| `scripts/update.sh`, `backup.sh`, `restore.sh`, `lib.sh` | Host-side operations; see [backups-and-updates.md](backups-and-updates.md). |

## Tests

- `tests/owner-seed.test.ts`: seeding from the environment, and no second seed once an account exists.
- `tests/runtime-secrets.test.ts`: `secrets.json` generation and that the environment wins.
- `tests/password.test.ts`: the hash format `password:hash` prints.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `APP_ADMIN_EMAIL` | Owner's sign-in address, read once. | `<APP_USERNAME>@localhost` |
| `APP_ADMIN_PASSWORD` | Owner's initial password, at least 12 characters, read once. | none |
| `APP_PASSWORD_HASH` | scrypt hash instead of the plain password; wins if both are set. | none |
| `APP_ADMIN_FIRST_NAME`, `APP_ADMIN_LAST_NAME`, `APP_USERNAME` | Optional owner name; `admin` as the fallback address part. | |
| `NUXT_SESSION_PASSWORD` | Signs the session cookie. | generated |
| `BUGSTER_SECRET_KEY` | Encrypts stored App Store Connect keys. | generated |
| `NUXT_SESSION_COOKIE_SECURE` | `true` behind HTTPS. | `false` |
| `DATABASE_PATH` | The SQLite file. | `/data/open-bugster.sqlite` in Docker |
| `ATTACHMENTS_PATH` | The attachments directory. | `/data/attachments` in Docker |
| `AUDIT_RETENTION_DAYS` | Audit log retention; `0` keeps everything. | `365` |
| `WEBHOOK_ALLOW_PRIVATE` | Allow private destinations for webhooks and downloads. | `true` |
| `API_RATE_LIMIT` | Requests per minute per credential on the token surfaces. | `120` |
