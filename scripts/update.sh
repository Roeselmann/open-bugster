#!/usr/bin/env bash
#
# Pull, back up, rebuild, and check that the new container actually came up.
#
# The backup in the middle is the point of the script. Schema changes are applied
# automatically on start (server/utils/db.ts), and those migrations only run forwards —
# some of them rebuild tables outright. Once a new version has touched the database, the
# previous version can no longer read it, so the only way back is the archive taken here.
#
#   scripts/update.sh [--no-pull] [--prune]
#
# --no-pull  rebuild the working tree as it is, without touching git
# --prune    remove dangling images once the new container is healthy

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

require_compose

pull=true
prune=false
for arg in "$@"; do
  case "$arg" in
    --no-pull) pull=false ;;
    --prune) prune=true ;;
    *) die "unknown option: $arg" ;;
  esac
done

previous=""
if [ "$pull" = true ]; then
  git rev-parse --git-dir >/dev/null 2>&1 || die "not a git checkout — use --no-pull."
  if [ -n "$(git status --porcelain)" ]; then
    die "the working tree has local changes. Commit, stash, or discard them, or use --no-pull."
  fi
  previous=$(git rev-parse --short HEAD)
  note "Pulling …"
  git pull --ff-only
  current=$(git rev-parse --short HEAD)
  if [ "$previous" = "$current" ]; then
    note "Already at $current — rebuilding anyway."
  else
    note "$previous → $current"
  fi
fi

note ""
scripts/backup.sh pre-update
archive=$(ls -1t "$BACKUP_DIR"/pre-update-*.tar.gz 2>/dev/null | head -n 1)

rollback_hint() {
  note ""
  note "To go back:"
  note "  scripts/restore.sh $archive --yes"
  [ -n "$previous" ] && note "  git checkout $previous && docker compose up --build -d"
  note ""
  note "Restoring the data is not optional when the new version already started: its"
  note "migrations have rewritten the schema, and the old image cannot read it."
}

note ""
note "Building and starting …"
if ! docker compose up --build -d; then
  note "The build or start failed. The data volume was not touched — the old container may"
  note "still be running. Fix the error and re-run, or roll back:"
  rollback_hint
  exit 1
fi

# Migrations run when the first database connection is opened. The audit sweep at startup
# usually triggers that, but it returns early on AUDIT_RETENTION_DAYS=0 — so a request is
# what reliably proves the schema came up, not just the process.
address=$(docker compose port "$SERVICE" 3000 2>/dev/null | head -n 1 | sed 's/^0\.0\.0\.0:/127.0.0.1:/; s/^\[::\]:/127.0.0.1:/')
if [ -z "$address" ] || ! command -v curl >/dev/null 2>&1; then
  note "note: cannot reach the published port from here — check http://<host>:3000 yourself."
  running || { note "The container is not running:"; docker compose logs --tail 50 "$SERVICE"; rollback_hint; exit 1; }
  note "Container is up."
  exit 0
fi

note "Waiting for http://$address/ …"
deadline=$((SECONDS + 120))
while :; do
  if ! running; then
    note "The container exited during start:"
    docker compose logs --tail 50 "$SERVICE"
    rollback_hint
    exit 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$address/" || true)
  if [ -n "$code" ] && [ "$code" != 000 ] && [ "$code" -lt 500 ]; then
    note "Up, answering with HTTP $code."
    break
  fi
  if [ "$SECONDS" -ge "$deadline" ]; then
    note "No usable answer after two minutes (last status: ${code:-none})."
    docker compose logs --tail 50 "$SERVICE"
    rollback_hint
    exit 1
  fi
  sleep 2
done

if [ "$prune" = true ]; then
  note "Pruning dangling images …"
  docker image prune -f >/dev/null
fi

note ""
note "Update complete. The pre-update archive is kept at $archive."
