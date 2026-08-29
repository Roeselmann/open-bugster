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

# Where the service is published on the host, as a host:port curl can dial, or nothing.
#
# `docker compose port` is the direct question, but it answers ":0" when it cannot match a
# mapping rather than failing, so its output has to be checked instead of trusted. The
# container's own bindings answer the same question and are asked as a fallback. Either can
# name a wildcard host, which is fine to listen on and impossible to dial — those become
# loopback.
published_address() {
  local port=$1 cid
  # Nothing in here may report failure: the caller runs under `set -e` with `pipefail`, where a
  # non-zero anywhere in this pipeline would abort the update instead of leaving the address
  # empty for the caller to handle.
  cid=$(service_container) || cid=""
  {
    docker compose port "$SERVICE" "$port" 2>/dev/null || true
    if [ -n "$cid" ]; then
      docker inspect \
        -f "{{range \$b := index .NetworkSettings.Ports \"$port/tcp\"}}{{\$b.HostIp}}:{{\$b.HostPort}}{{println}}{{end}}" \
        "$cid" 2>/dev/null || true
    fi
  } | sed 's/^\[\(.*\)\]:/\1:/' | awk -F: '
      NF > 1 {
        p = $NF
        h = substr($0, 1, length($0) - length(p) - 1)
        if (p !~ /^[0-9]+$/ || p + 0 == 0) next
        if (h == "" || h == "0.0.0.0" || h == "::" || h == "*") h = "127.0.0.1"
        if (h ~ /:/) h = "[" h "]"
        print h ":" p
        exit
      }'
}

# One request to the application, printing the HTTP status it answered with, or 000.
#
# Two ways in, because whether the application is reachable from the host is an installation's
# choice, not a given: put it behind a reverse proxy on a shared network and it publishes no
# host port at all. Inside the container it is always reachable. The image has no curl or
# wget — it is node:22-slim — but it does have the node that runs the application, and node 22
# has fetch built in.
host_probe() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$1" 2>/dev/null || true
}

container_probe() {
  docker compose exec -T "$SERVICE" node -e '
    fetch(process.argv[1], { signal: AbortSignal.timeout(5000) })
      .then(r => process.stdout.write(String(r.status)))
      .catch(() => process.stdout.write("000"))
  ' "$1" 2>/dev/null || true
}
