#!/usr/bin/env bash
#
# A consistent snapshot of everything that cannot be rebuilt from the repository: the
# SQLite file with its WAL, the attachments directory, and the `.env` that holds
# BUGSTER_SECRET_KEY. The last one matters more than it looks — without the original key
# the stored App Store Connect keys stay encrypted even when the database is restored.
#
#   scripts/backup.sh [label]
#
# BACKUP_DIR   where archives are written (default: backups/)
# BACKUP_KEEP  how many archives of the same label to keep (default: 10, 0 keeps all)

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

require_compose

label=${1:-backup}
keep=${BACKUP_KEEP:-10}
volume=$(data_volume)
image=$(helper_image)
name="$label-$(date +%Y-%m-%d-%H%M%S).tar.gz"

mkdir -p "$BACKUP_DIR"
[ -f .env ] || die ".env not found. It belongs in the archive — a backup without it cannot decrypt the stored App Store Connect keys."

# SQLite in WAL mode and a separate attachments directory cannot be copied consistently
# while the application writes to them. Stopping costs a few seconds and removes the
# question entirely; a hot copy would only look like a backup.
restart=false
if running; then
  restart=true
  note "Stopping $SERVICE for a consistent snapshot …"
  docker compose stop "$SERVICE" >/dev/null
fi
restart_service() { [ "$restart" = true ] && docker compose start "$SERVICE" >/dev/null 2>&1 || true; }
trap restart_service EXIT

# Mounting the volume and `.env` under one root lets a single tar pass produce an archive
# holding `./data/…` and `./env`, with no intermediate copy of the attachments.
note "Writing $BACKUP_DIR/$name …"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v "$volume":/snapshot/data:ro \
  -v "$PWD/.env":/snapshot/env:ro \
  -v "$PWD/$BACKUP_DIR":/out \
  "$image" tar czf "/out/$name" -C /snapshot .

chmod 600 "$BACKUP_DIR/$name"

if [ "$keep" -gt 0 ]; then
  ls -1t "$BACKUP_DIR/$label"-*.tar.gz 2>/dev/null | tail -n +$((keep + 1)) | while IFS= read -r old; do
    note "Removing old archive $old"
    rm -f "$old"
  done
fi

note "Done: $BACKUP_DIR/$name ($(du -h "$BACKUP_DIR/$name" | cut -f1))"
note "Restore with: scripts/restore.sh $BACKUP_DIR/$name"
