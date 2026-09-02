# Backups and updates

Three host-side scripts cover the whole cycle. They orchestrate Docker from outside the container, unlike the `npm run` commands, which run inside it.

```bash
scripts/update.sh    # pull, back up, rebuild, and verify the new container answers
scripts/backup.sh    # a consistent archive of the volume and .env, on its own
scripts/restore.sh backups/<archive>.tar.gz   # put one back
```

## Using it

### What survives an update

Everything that matters lives in the named volume `bugster-data`, mounted at `/data`: the SQLite file with its write-ahead log, the attachments directory beside it, and `secrets.json` with the machine secrets generated on the first start. The image holds no state at all, so `docker compose up --build -d` replaces the container and leaves the volume untouched. Restarts, rebuilds, `docker compose down`, and a reboot of the host are all harmless.

Alongside it may sit `.env` on the host, read at runtime and deliberately kept out of the image. If it carries `BUGSTER_SECRET_KEY`, that value overrides the generated one, and a database restored without the matching `.env` opens fine but every stored `.p8` stays unreadable. That is why `scripts/backup.sh` puts the volume and `.env` in the same archive; with generated secrets the volume alone is already self-contained.

Only three things actually destroy data, and all three have to be done on purpose: `docker compose down -v` or `docker volume rm`, losing the `.env` that holds a self-managed `BUGSTER_SECRET_KEY`, and restoring over a volume without a current archive.

### Why the backup is not optional

Schema changes are applied on the first database connection after a start, by the `ensure*` migrations in `server/utils/db.ts`. They are idempotent, so a second start changes nothing, and several of them rebuild tables outright rather than only adding columns.

They only run forwards. Once a new version has started against the volume, the previous version can no longer read it, and rolling back means restoring the archive *and* checking out the old commit, not simply starting the old image. `scripts/update.sh` therefore takes a `pre-update-*` archive between the pull and the build, and prints both commands if the new container fails to come up.

### Taking a backup

```bash
scripts/backup.sh
```

The container is stopped for the few seconds the copy takes and started again afterwards. That is on purpose: SQLite in WAL mode and a separate attachments directory cannot be copied consistently while the application writes to them, and a hot copy would only look like a backup.

Archives are written to `backups/` with mode `600`, since they contain `.env`, and named after the label passed as the first argument, `backup` by default. `BACKUP_KEEP` decides how many of each label are kept (10 by default, `0` keeps all), and `BACKUP_DIR` moves the directory somewhere else, an off-host mount included. `backups/` is gitignored; a copy that never leaves the server is only half a backup.

### Restoring

```bash
scripts/restore.sh backups/pre-update-2026-08-28-1400.tar.gz
```

It asks for confirmation, stops the stack, replaces the volume contents, and starts again. If the `.env` in the archive differs from the one on disk it says so, and `--env` puts the archive's copy in place, keeping the current one as `.env.replaced-*`. Add `--yes` to skip the prompt in a script.

### Updating

```bash
scripts/update.sh
```

Refuses to run on a dirty working tree, pulls fast-forward only, writes a `pre-update` archive, rebuilds, and then waits for the application to answer a request, because that is what proves the migrations went through. It asks the published port when there is one and the container itself when there is not, so an installation behind a reverse proxy is checked the same way. On a failure it prints the container log and the two commands that undo the update. `--no-pull` rebuilds the working tree as it stands, `--prune` removes dangling images once the new container is healthy.

### Commands inside the container

```bash
npm run password:hash -- "a-long-password"           # hash for APP_PASSWORD_HASH in .env
npm run owner:reset -- you@example.com "a-password"  # restore access, see setup.md
```

## How it works

- **The scripts share `scripts/lib.sh`**: locating the compose service and its volume (the volume name carries the compose project prefix, so it is asked from Docker rather than hard-coded), stopping and starting, and the archive layout.
- **An archive** is a tarball of the volume contents plus `.env`, written with restrictive permissions.
- **Migrations run inside `getDb()`** on the first connection, in a fixed order, each guarded by a schema sniff so it is a no-op when already applied. See [architecture.md](architecture.md#data-layer).
- **Startup housekeeping** also prunes expired idempotency keys, old webhook delivery attempts, and audit entries past their retention; none of that touches tickets.

## Code map

| File | What lives there |
|---|---|
| `scripts/update.sh` | Pull, backup, rebuild, health check, rollback hints. |
| `scripts/backup.sh` | Stop, archive volume and `.env`, restart, rotate by `BACKUP_KEEP`. |
| `scripts/restore.sh` | Confirm, stop, replace volume contents, optionally replace `.env`, start. |
| `scripts/lib.sh` | Shared helpers, sourced by the three above. |
| [server/utils/db.ts](../server/utils/db.ts) | `getDb` and the `ensure*` migration chain. |
| [server/plugins/audit-retention.ts](../server/plugins/audit-retention.ts) | The startup sweep. |

## Tests

The scripts have no automated tests. The migrations are covered by `tests/person-identity.test.ts`, `tests/workspaces.test.ts`, and `tests/db.test.ts`, which run them against legacy and fresh databases.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `BACKUP_DIR` | Where archives are written. | `backups` |
| `BACKUP_KEEP` | Archives kept per label; `0` keeps all. | `10` |
