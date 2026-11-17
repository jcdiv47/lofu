#!/usr/bin/env bash
# Production deploys. Production runs from its own directory ($LOFU_PROD_DIR,
# default ~/lofu-prod) with its own data, compose project (lofu-prod) and
# ports, so nothing done in this checkout touches it. It runs images CI built
# and pushed for a commit on main, never a local build.
#
#   docker/prod.sh init               create $LOFU_PROD_DIR with a .env to fill in
#   docker/prod.sh deploy [ref]       back up, deploy origin/main (or ref), wait until healthy
#   docker/prod.sh rollback           go back to the release before the last deploy
#   docker/prod.sh backup [--keep N]  snapshot the database (run nightly, see README)
#   docker/prod.sh status             containers, deployed commit, health
#   docker/prod.sh <compose args>     e.g. logs -f server | exec server bun src/admin.ts token list
#
# $LOFU_PROD_DIR holds:
#   .env          yours: MEILI_MASTER_KEY, LOFU_DATA, ports, LOFU_BACKUP_COPY_TO
#   compose.yaml  docker/compose.yaml as of the deployed commit
#   compose.tailscale.yaml  the Tailscale sidecar, likewise (when TS_HOSTNAME is set)
#   release.env   the deployed image (LOFU_IMAGE, LOFU_TAG, LOFU_COMMIT)
#   previous.env  the release before it and the backup taken first (for rollback)
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"

repo=$(git -C "$here" rev-parse --show-toplevel)
dir=${LOFU_PROD_DIR:-$HOME/lofu-prod}
project=lofu-prod
image=${LOFU_PROD_IMAGE:-ghcr.io/jcdiv47/lofu-server}

# With TS_HOSTNAME set, the server is reached through its own tailnet node
# (compose.tailscale.yaml) instead of a loopback port.
tailscale_on() { [ -n "$(env_value "$dir/.env" TS_HOSTNAME)" ]; }

compose() {
  local args=(-f "$dir/compose.yaml")
  [ -f "$dir/compose.tailscale.yaml" ] && args+=(-f "$dir/compose.tailscale.yaml")
  args+=(--env-file "$dir/.env")
  [ -f "$dir/release.env" ] && args+=(--env-file "$dir/release.env")
  docker compose -p "$project" --project-directory "$dir" "${args[@]}" "$@"
}

# Stages the compose files of a commit in $dir/next/; install_compose puts them in place.
stage_compose() { # sha
  rm -rf "$dir/next" && mkdir -p "$dir/next"
  git -C "$repo" show "$1:docker/compose.yaml" >"$dir/next/compose.yaml"
  if tailscale_on; then
    git -C "$repo" show "$1:docker/compose.tailscale.yaml" >"$dir/next/compose.tailscale.yaml" 2>/dev/null ||
      die "$1 has no docker/compose.tailscale.yaml, but TS_HOSTNAME is set"
  fi
}

install_compose() {
  rm -f "$dir/compose.yaml" "$dir/compose.tailscale.yaml"
  mv "$dir/next/"* "$dir/" && rmdir "$dir/next"
}

load_env() {
  [ -f "$dir/.env" ] || die "no $dir/.env; run: docker/prod.sh init"
  data=$(env_value "$dir/.env" LOFU_DATA)
  [[ $data == /* ]] || die "set LOFU_DATA in $dir/.env to an absolute path"
  [ -n "$(env_value "$dir/.env" MEILI_MASTER_KEY)" ] || die "set MEILI_MASTER_KEY in $dir/.env"
}

have_image() {
  docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null
}

server_running() {
  [ -f "$dir/compose.yaml" ] && [ -n "$(compose ps -q --status running server 2>/dev/null)" ]
}

# The deployed server's /health, from inside its container.
health() {
  compose exec -T server bun -e \
    "const r = await fetch('http://127.0.0.1:8787/health'); console.log(await r.text()); process.exit(r.ok ? 0 : 1)"
}

# Schema version of a database file under $data/server, read without migrating.
schema_version() { # file-in-/data image
  docker run --rm --user 1000:1000 -v "$data/server:/data" "$2" bun -e \
    "const { Database } = require('bun:sqlite'); const db = new Database('/data/$1', { readonly: true }); console.log(db.query('PRAGMA user_version').get().user_version)"
}

# Copies a backup off the machine if LOFU_BACKUP_COPY_TO is set (a directory,
# or an rsync target such as nas:/backups/lofu).
copy_off() { # host-path
  local to
  to=$(env_value "$dir/.env" LOFU_BACKUP_COPY_TO)
  [ -n "$to" ] || return 0
  if [[ $to == *:* ]]; then rsync -t "$1" "$to/"; else mkdir -p "$to" && cp -p "$1" "$to/"; fi
  echo "copied to $to"
}

# Snapshots the database and prints the host path of the copy.
take_backup() { # label [admin args...]
  local label=$1 out
  shift
  mkdir -p "$data/server/backups"
  if server_running; then
    out=$(compose exec -T server bun src/admin.ts backup --label "$label" "$@") || die "backup failed"
    out="$data/server/${out#/data/}"
  elif [ -f "$data/server/lofu.db" ]; then
    # Nothing running: snapshot with plain SQLite (no migrations) in any Bun image.
    # Any image will do (backup_image: the one being deployed, else the current one).
    local name img
    name="lofu-$(date -u +%Y%m%dT%H%M%SZ)-$label.db"
    img=${backup_image:-$(env_value "$dir/release.env" LOFU_IMAGE):$(env_value "$dir/release.env" LOFU_TAG)}
    [ "$img" != ":" ] || die "the server isn't running and there's no image to back up with"
    docker run --rm --user 1000:1000 -v "$data/server:/data" "$img" bun -e \
      "const { Database } = require('bun:sqlite'); new Database('/data/lofu.db').run(\"VACUUM INTO '/data/backups/$name'\")" \
      || die "backup failed"
    out="$data/server/backups/$name"
  else
    return 0 # a fresh install has nothing to back up
  fi
  echo "$out"
}

wait_healthy() { # sha
  echo "starting $1..."
  if ! compose up -d --no-build --remove-orphans --wait --wait-timeout 180; then
    compose logs --tail 40 server >&2 || true
    return 1
  fi
  local h
  h=$(health) || { echo "$h" >&2; return 1; }
  echo "health: $h"
  [[ $h == *"\"commit\":\"$1\""* ]] || { echo "the server reports a different commit than $1" >&2; return 1; }
}

cmd_init() {
  mkdir -p "$dir"
  if [ -f "$dir/.env" ]; then
    echo "$dir/.env already exists"
  else
    umask 077
    sed -e "s|^MEILI_MASTER_KEY=.*|MEILI_MASTER_KEY=$(openssl rand -base64 32)|" \
      -e "s|^LOFU_DATA=.*|LOFU_DATA=$dir/data|" "$here/prod.env.example" >"$dir/.env"
    echo "wrote $dir/.env; review it, then: docker/prod.sh deploy"
  fi
}

cmd_deploy() {
  load_env
  local ref=${1:-origin/main} sha backup="" prev_tag=""
  git -C "$repo" fetch -q origin
  sha=$(git -C "$repo" rev-parse --verify --quiet "$ref^{commit}") || die "unknown ref $ref"
  git -C "$repo" cat-file -e "$sha:docker/prod.sh" 2>/dev/null || die "$sha predates image deploys"
  prev_tag=$(env_value "$dir/release.env" LOFU_TAG)
  [ "$prev_tag" != "$sha" ] || { echo "$sha is already deployed"; cmd_status; return; }

  guard_data "$data" "$project"
  # Pull first: if CI hasn't built this commit (or failed), nothing has changed yet.
  have_image "$image:$sha" ||
    die "no image $image:$sha. Has CI finished for it? (A private package also needs: docker login ghcr.io)"

  mkdir -p "$data/server" "$data/meili"
  if tailscale_on; then mkdir -p "$data/tailscale"; fi
  stage_compose "$sha"

  # Migrations run on startup and only go forward, and a build refuses a
  # newer schema, so this backup is the way back if the new release fails.
  backup=$(backup_image="$image:$sha" take_backup "pre-${sha:0:12}")
  [ -z "$backup" ] || echo "backup: $backup"

  if [ -f "$dir/release.env" ]; then
    { cat "$dir/release.env"; echo "BACKUP=$backup"; } >"$dir/previous.env"
  fi
  install_compose
  printf 'LOFU_IMAGE=%s\nLOFU_TAG=%s\nLOFU_COMMIT=%s\n' "$image" "$sha" "$sha" >"$dir/release.env"

  if ! wait_healthy "$sha"; then
    echo >&2
    echo "deploy of $sha FAILED. To go back to the previous release: docker/prod.sh rollback" >&2
    exit 1
  fi
  echo "deployed $sha ($(git -C "$repo" log -1 --format=%s "$sha"))"
}

cmd_rollback() {
  load_env
  [ -f "$dir/previous.env" ] || die "nothing to roll back to (no $dir/previous.env)"
  local tag backup cur_v old_v failed restored=""
  tag=$(env_value "$dir/previous.env" LOFU_TAG)
  backup=$(env_value "$dir/previous.env" BACKUP)
  echo "rolling back to $tag"
  have_image "$image:$tag" || die "no image $image:$tag"
  stage_compose "$tag"

  compose stop server
  # Restore the backup only if the failed release migrated the schema: the
  # old build refuses a newer one. Otherwise keep the data as it is now.
  if [ -n "$backup" ] && [ -f "$data/server/lofu.db" ]; then
    cur_v=$(schema_version lofu.db "$image:$tag")
    old_v=$(schema_version "backups/$(basename "$backup")" "$image:$tag")
    if [ "$cur_v" != "$old_v" ]; then
      failed="$data/server/backups/failed-$(date -u +%Y%m%dT%H%M%SZ)"
      mkdir -p "$failed"
      mv "$data/server"/lofu.db* "$failed/"
      cp -p "$backup" "$data/server/lofu.db"
      echo "schema v$cur_v -> v$old_v: restored $backup (the newer database is in $failed)"
      restored=1
    fi
  fi

  install_compose
  grep -v '^BACKUP=' "$dir/previous.env" >"$dir/release.env"
  rm "$dir/previous.env"
  wait_healthy "$tag" || die "the previous release didn't come up either; see: docker/prod.sh logs server"
  if [ -n "$restored" ]; then
    # Search holds documents the restored database doesn't; rebuild it.
    compose exec -T server bun src/admin.ts reindex
  fi
  echo "rolled back to $tag"
}

cmd_backup() {
  load_env
  local out
  out=$(take_backup nightly "$@")
  [ -n "$out" ] || die "no database to back up"
  echo "$out"
  copy_off "$out"
}

cmd_status() {
  load_env
  [ -f "$dir/compose.yaml" ] || { echo "nothing deployed yet"; return; }
  compose ps
  echo "deployed: $(env_value "$dir/release.env" LOFU_TAG)"
  if server_running; then echo "health: $(health || true)"; fi
  if tailscale_on; then
    echo "url: https://$(compose exec -T tailscale tailscale status --json --peers=false |
      sed -n 's/^ *"DNSName": "\(.*\)\.",*$/\1/p' | head -n 1)"
  fi
}

case ${1:-} in
init) cmd_init ;;
deploy) shift; cmd_deploy "$@" ;;
rollback) cmd_rollback ;;
backup) shift; cmd_backup "$@" ;;
status) cmd_status ;;
"" | -h | --help) sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' ;;
*)
  load_env
  [ -f "$dir/compose.yaml" ] || die "nothing deployed yet"
  compose "$@"
  ;;
esac
