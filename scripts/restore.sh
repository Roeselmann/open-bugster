#!/usr/bin/env bash
#
# Puts an archive from scripts/backup.sh back. This is the half that makes a backup mean
# something: the schema migrations in server/utils/db.ts only ever run forwards, so an
# update that goes wrong is undone by restoring data *and* checking out the old commit —
# never by starting the old image on the new database.
#
#   scripts/restore.sh backups/pre-update-2026-08-28-1400.tar.gz [--yes] [--env]
#
# --yes  skip the confirmation prompt
# --env  also overwrite .env with the copy from the archive

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

require_compose

archive=""
assume_yes=false
restore_env=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) assume_yes=true ;;
    --env) restore_env=true ;;
    -*) die "unknown option: $arg" ;;
    *) archive=$arg ;;
  esac
done

[ -n "$archive" ] || die "usage: scripts/restore.sh <archive.tar.gz> [--yes] [--env]"
[ -f "$archive" ] || die "no such archive: $archive"
archive=$(cd "$(dirname "$archive")" && printf '%s/%s\n' "$PWD" "$(basename "$archive")")

volume=$(data_volume)
image=$(helper_image)

if [ "$assume_yes" != true ]; then
  note "This replaces the entire contents of volume '$volume' with $archive."
  printf 'Type "restore" to continue: '
  read -r answer
  [ "$answer" = restore ] || die "aborted."
fi

note "Stopping the stack …"
docker compose down >/dev/null

# `find -mindepth 1 -delete` empties the volume without removing the mount point itself,
# which a plain `rm -rf /data` would. The chown afterwards is not cosmetic: the Dockerfile
# runs the server as `node` (uid 1000), and files unpacked by root would be unwritable.
note "Restoring the data volume …"
docker run --rm \
  -v "$volume":/target \
  -v "$archive":/archive.tar.gz:ro \
  "$image" sh -c 'find /target -mindepth 1 -delete && tar xzf /archive.tar.gz -C /target --strip-components=2 ./data && chown -R 1000:1000 /target'

# The secret in .env decides whether the restored App Store Connect keys can be read at
# all, so a mismatch is worth saying out loud rather than discovering at the next sync.
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
docker run --rm --user "$(id -u):$(id -g)" \
  -v "$archive":/archive.tar.gz:ro -v "$staging":/out \
  "$image" tar xzf /archive.tar.gz -C /out ./env 2>/dev/null || true

if [ -f "$staging/env" ]; then
  if [ "$restore_env" = true ]; then
    cp .env ".env.replaced-$(date +%Y-%m-%d-%H%M%S)" 2>/dev/null || true
    cp "$staging/env" .env
    note "Restored .env from the archive; the previous one was kept as .env.replaced-*."
  elif [ -f .env ] && ! cmp -s "$staging/env" .env; then
    note "note: the .env in the archive differs from the one on disk. If the stored App Store"
    note "      Connect keys come back unreadable, re-run with --env."
  fi
else
  note "note: the archive carries no .env. That is fine when the secrets were generated on"
  note "      first start — they live in the volume and were just restored with it. Otherwise"
  note "      make sure the BUGSTER_SECRET_KEY on disk is the one this data was written with."
fi

note "Starting the stack …"
docker compose up -d

note "Done. If this undoes a failed update, check out the matching commit as well:"
note "  git checkout <commit-before-the-update> && docker compose up --build -d"
