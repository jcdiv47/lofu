#!/usr/bin/env bash
# The development stack: `docker compose` on compose.yaml, plus
# compose.override.yaml when it exists. Compose only picks the override up by
# itself when it's run from docker/ without -f, which `bun run stack:*` isn't.
#
#   docker/compose.sh up -d --build      (bun run stack:up)
#   docker/compose.sh logs -f server
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$here/lib.sh"

files=(-f "$here/compose.yaml")
[ -f "$here/compose.override.yaml" ] && files+=(-f "$here/compose.override.yaml")

# /health reports what the image was built from; -dirty marks local edits.
LOFU_COMMIT=${LOFU_COMMIT:-$(git -C "$here" describe --always --dirty --abbrev=12 2>/dev/null || echo dev)}
export LOFU_COMMIT

if [[ " $* " == *" up "* ]]; then
  data=$(env_value "$here/.env" LOFU_DATA)
  data=${data:-../data}
  [[ $data == /* ]] || data="$here/$data"
  data=$(realpath -m "$data")
  guard_data "$data" lofu
fi

exec docker compose "${files[@]}" "$@"
