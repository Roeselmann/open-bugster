# Shared helpers for the host-side operations scripts. Sourced, never run directly.
#
# These three scripts orchestrate Docker from outside the container, which is why they are
# shell and not the `.mjs` scripts next to them: those run *inside* the container and talk
# to the database, these run on the host and talk to the daemon.

SERVICE=bugster
BACKUP_DIR=${BACKUP_DIR:-backups}

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

require_compose() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed."
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is not available."
  [ -f docker-compose.yml ] || die "docker-compose.yml not found — run this from the repository root."
}

service_container() {
  docker compose ps -aq "$SERVICE" 2>/dev/null | head -n 1
}

running() {
  local cid
  cid=$(service_container)
  [ -n "$cid" ] || return 1
  [ "$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null)" = true ]
}

# The volume name carries the compose project as a prefix, so it cannot be hard-coded. Ask
# the container which volume sits on /data; only fall back to the naming convention when no
# container has ever been created.
data_volume() {
  local cid name
  cid=$(service_container)
  if [ -n "$cid" ]; then
    name=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$cid")
    if [ -n "$name" ]; then printf '%s\n' "$name"; return; fi
  fi
  name="${COMPOSE_PROJECT_NAME:-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alnum:]_-')}_bugster-data"
  docker volume inspect "$name" >/dev/null 2>&1 \
    || die "cannot find the data volume (looked for '$name'). Start the stack once, or set COMPOSE_PROJECT_NAME."
  printf '%s\n' "$name"
}

# Copying the volume needs a container with `tar` in it, and the application image already
# is one. Preferring it keeps backups working on a server with no registry access.
helper_image() {
  local image
  image=$(docker compose images -q "$SERVICE" 2>/dev/null | head -n 1)
  if [ -n "$image" ]; then printf '%s\n' "$image"; else printf '%s\n' "${HELPER_IMAGE:-alpine:3}"; fi
}
