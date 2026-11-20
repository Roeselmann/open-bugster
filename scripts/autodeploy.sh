#!/usr/bin/env bash
#
# Pull-based release: run by a systemd timer on the server every two minutes, it ships
# whatever is on the release branch (main) and does nothing when that has not moved.
# See docs/deployment.md.
#
#   scripts/autodeploy.sh [branch]      (default: main)
#
# One run, when origin/<branch> is ahead of the deployed commit:
#
#   1. fast-forward the checkout and build the new image. The running container is not
#      touched yet, so a failed build costs nothing: the checkout goes back to the deployed
#      commit and the old version stays online.
#   2. take a pre-update archive (scripts/backup.sh; the container stops for a few seconds).
#   3. start the new image and wait until it answers.
#   4. if it does not come up, roll back on its own: the old image, the old commit, and the
#      archive from step 2. The archive is not optional — the migrations have already run
#      forwards, and the old image cannot read the new schema.
#
# A commit that failed is remembered and not retried every two minutes; the next push is.
# The deployed commit is kept in .git/autodeploy-deployed, so a hand-made `git pull` on the
# server does not hide a release from the timer.

set -euo pipefail
cd "$(dirname "$0")/.."
. scripts/lib.sh

require_compose

branch=${1:-main}
git_dir=$(git rev-parse --absolute-git-dir)
deployed_file="$git_dir/autodeploy-deployed"
failed_file="$git_dir/autodeploy-failed"

# Never two runs at once: a build takes longer than the timer's interval. The lock name
# matches the generic /usr/local/sbin/git-autodeploy, so the two never race on this folder.
if command -v flock >/dev/null 2>&1; then
  exec 9>"/run/lock/git-autodeploy-$(basename "$PWD").lock"
  flock -n 9 || exit 0
fi

git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")
previous=$(cat "$deployed_file" 2>/dev/null || git rev-parse HEAD)

[ "$target" = "$previous" ] && exit 0
[ "$(cat "$failed_file" 2>/dev/null || true)" = "$target" ] && exit 0

short() { git log --oneline -1 "$1"; }
note "New release on $branch: $(short "$target")"
note "Running now:           $(short "$previous")"

[ -z "$(git status --porcelain)" ] \
  || die "the checkout has local changes — not deploying. See 'git status' in $PWD."

cid=$(service_container)
old_image=""
image_name=""
if [ -n "$cid" ]; then
  old_image=$(docker inspect -f '{{.Image}}' "$cid")
  image_name=$(docker inspect -f '{{.Config.Image}}' "$cid")
fi

# Put the checkout (and, once rebuilt, the image tag) back where the running version is, and
# remember the commit so the next tick does not build it again.
give_up() {
  git reset --quiet --hard "$previous"
  if [ -n "$old_image" ] && [ -n "$image_name" ]; then
    docker tag "$old_image" "$image_name"
  fi
  printf '%s\n' "$target" >"$failed_file"
  note "Not deployed: $(short "$target"). Still running $(short "$previous")."
  note "The next push to $branch is tried again."
  exit 1
}

git merge --ff-only --quiet "$target" || give_up

note ""
note "Building …"
if ! docker compose build "$SERVICE"; then
  note "The build failed. The running container was not touched."
  give_up
fi

note ""
if ! scripts/backup.sh pre-update; then
  note "The backup failed, so the new version is not started."
  give_up
fi
archive=$(ls -1t "$BACKUP_DIR"/pre-update-*.tar.gz | head -n 1)

note ""
note "Starting the new version …"
if docker compose up -d --no-build --remove-orphans && wait_until_up; then
  printf '%s\n' "$target" >"$deployed_file"
  rm -f "$failed_file"
  docker image prune -f >/dev/null || true
  note ""
  note "Deployed: $(short "$target") (archive taken before: $archive)"
  exit 0
fi

note ""
note "The new version did not come up. Rolling back to $(short "$previous") and $archive …"
if [ -z "$old_image" ]; then
  note "There was no previous container to go back to — fix the release and push again."
  give_up
fi
git reset --quiet --hard "$previous"
docker tag "$old_image" "$image_name"
printf '%s\n' "$target" >"$failed_file"
if scripts/restore.sh "$archive" --yes && wait_until_up; then
  note "Rolled back: $(short "$previous") is running again on the data from before the update."
else
  note "ROLLBACK FAILED — the instance is likely down. By hand, in $PWD:"
  note "  scripts/restore.sh $archive --yes"
  note "  docker compose up -d"
fi
exit 1
