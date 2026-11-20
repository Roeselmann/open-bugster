# Deployment

How a change gets from a laptop to the running instance: `develop` for testing locally, `main` as the release branch, and a server that pulls `main` by itself every two minutes. Merging into `main` and pushing *is* the release; nothing else has to be done on the server.

```text
develop (local) ──merge──▶ main ──push──▶ GitHub ◀── every 2 min ── server
                                                                     │
                                         fetch · build · back up · start · check
                                                 └── rolls back if it does not come up
```

## Using it

### Releasing

```bash
git switch develop          # day-to-day work, tested against the local or scratch instance
npm run typecheck && npx vitest run
git switch main
git merge --ff-only develop # or a plain merge, if main has moved
git push origin main        # released: the server picks it up within ~2–5 minutes
git switch develop
```

Anything on `main` counts as released. Work that is not ready stays on `develop` (or a branch off it) and is never merged into `main` "to try it out" — the server would ship it.

### Watching a release

On the server:

```bash
journalctl -u git-autodeploy@open-bugster -n 50     # what the last runs did
journalctl -u git-autodeploy@open-bugster -f        # follow the next one
systemctl list-timers 'git-autodeploy@*'            # when it looks next
systemctl start git-autodeploy@open-bugster         # look now instead of waiting
cat /root/open-bugster/.git/autodeploy-deployed     # the commit that is live
```

A run with nothing new logs nothing but systemd's own start and finish lines. A release logs `New release on main: …`, the build, the backup, and ends in `Deployed: …`. It takes as long as the Docker build, a few minutes. The instance is unreachable for well under a minute of that: the seconds the backup stops the container, then the new container's start until its healthcheck passes, because the reverse proxy only routes to a healthy container.

### When something goes wrong

- **The build fails** (`The build failed. The running container was not touched.`): the old version stays online, the checkout goes back to the live commit, and the failed commit is written to `.git/autodeploy-failed` so it is not rebuilt every two minutes. Fix it on `develop`, merge, push; the new commit is tried as usual.
- **The release builds but does not come up** (`The new version did not come up. Rolling back …`): the script puts the previous image back, checks out the previous commit, and restores the `pre-update-*` archive it took a minute earlier, because the new version's migrations may already have changed the schema. The data written in between is only what the failed container wrote, which is nothing if it never answered. Fix and push again.
- **A release is live but wrong:** `git revert <commit>` on `main` and push. The revert is shipped like any other release. If that release ran a migration the old code cannot read, revert is not enough: restore its `pre-update-*` archive by hand (see [backups-and-updates.md](backups-and-updates.md#restoring)).
- **`ROLLBACK FAILED`:** the instance is probably down. Run the two commands the log prints, in the checkout.
- **The checkout has local changes** (`not deploying`): someone edited files on the server. `git -C /root/open-bugster status`, then commit them through the repository or discard them.
- **Pausing it**, for example while working on the server: `systemctl stop git-autodeploy@open-bugster.timer`, and `systemctl start …` to resume. Commits pushed in the meantime ship on the first run after.
- **`.env` changed on the server:** that does not move `main`, so nothing is deployed. Apply it by hand with `docker compose up -d` in the checkout.

## How it works

- **Pull, not push.** GitHub has no access to the server. The server reads the repository with its own deploy key (`core.sshCommand` in the checkout's git config), so the only things that need to reach it are HTTP(S) for the application and SSH for an administrator.
- **The timer** is the generic `git-autodeploy@.timer` already on the host for other sites: `OnUnitInactiveSec=2min`, measured from the end of the previous run, so runs never pile up. For this instance a systemd drop-in replaces the generic script with [`scripts/autodeploy.sh`](../scripts/autodeploy.sh), which knows about the backup and the migrations.
- **One run of `scripts/autodeploy.sh`:**
  1. Takes a lock, so a manual run and the timer never overlap.
  2. `git fetch origin main`. If `origin/main` equals the live commit, or the commit that last failed, it exits silently.
  3. Refuses a dirty checkout, fast-forwards, and runs `docker compose build`. The running container is untouched until here.
  4. `scripts/backup.sh pre-update` stops the container for the few seconds a consistent copy of the SQLite file, its WAL, the attachments and `.env` takes, then starts it again.
  5. `docker compose up -d --no-build`, then waits up to two minutes for an HTTP answer from inside the container (`wait_until_up` in `scripts/lib.sh`, shared with `update.sh`). An answer means the `ensure*` migrations have run.
  6. On success records the commit in `.git/autodeploy-deployed` and prunes dangling images. On failure rolls back as described above.
- **The live commit is kept apart from `HEAD`** in `.git/autodeploy-deployed`, so a `git pull` done by hand on the server still gets built and started on the next tick instead of being mistaken for "already live". Without the file, `HEAD` counts as live.
- **Archives** go to `backups/` in the checkout, mode `600`, rotated by `BACKUP_KEEP` (10 per label). Every release adds one `pre-update-*` archive the size of the volume.
- **The script runs from the checkout it updates.** Git replaces files rather than rewriting them, so the run in progress finishes with the version it started with; the next tick uses the new one. A commit that breaks `autodeploy.sh` itself stops automatic releases until it is fixed by hand on the server.
- **Which compose files** are used is decided by `COMPOSE_FILE` in the server's `.env` (here the repository's `docker-compose.yml` plus an override outside the repository with the reverse-proxy labels), so the script needs no knowledge of them.

## Setting it up on a server

Once per installation, as root, in a checkout on `main` that already runs (see [setup.md](setup.md)):

```bash
# 1. The generic units, unless the host has them already
cat >/etc/systemd/system/git-autodeploy@.service <<'EOF'
[Unit]
Description=Git-Autodeploy für /root/%i
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/git-autodeploy /root/%i main
TimeoutStartSec=30min
EOF
cat >/etc/systemd/system/git-autodeploy@.timer <<'EOF'
[Unit]
Description=Git-Autodeploy für /root/%i (alle 2 Minuten)

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min
RandomizedDelaySec=10s

[Install]
WantedBy=timers.target
EOF

# 2. This instance uses its own script instead of the generic one
mkdir -p /etc/systemd/system/git-autodeploy@open-bugster.service.d
cat >/etc/systemd/system/git-autodeploy@open-bugster.service.d/bugster.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/root/open-bugster/scripts/autodeploy.sh main
EOF

# 3. Tell it which commit is live right now, then switch it on
git -C /root/open-bugster rev-parse HEAD > /root/open-bugster/.git/autodeploy-deployed
systemctl daemon-reload
systemctl enable --now git-autodeploy@open-bugster.timer
```

The instance name after `@` is the folder under `/root`. A checkout elsewhere needs its path in the drop-in's `ExecStart` instead.

## Code map

| File | What lives there |
|---|---|
| [scripts/autodeploy.sh](../scripts/autodeploy.sh) | One timer run: fetch, build, back up, start, check, roll back. |
| [scripts/lib.sh](../scripts/lib.sh) | `wait_until_up` and the compose helpers it shares with the other scripts. |
| [scripts/backup.sh](../scripts/backup.sh), [scripts/restore.sh](../scripts/restore.sh) | The archive taken before each release and the restore used by the rollback. |
| [scripts/update.sh](../scripts/update.sh) | The manual equivalent, for installations without the timer. |

## Tests

No automated tests. The script was exercised on a separate stack on the server (own compose project, volume and port, a local bare repository as `origin`) through a normal release, a build failure, and a release whose container exits on start.

## Configuration

| Variable | Purpose | Default |
|---|---|---|
| `BACKUP_KEEP` | `pre-update-*` archives kept; set it in the drop-in with `Environment=` to change it. | `10` |
| `BACKUP_DIR` | Where the archives go. | `backups` |
