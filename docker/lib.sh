# Shared by compose.sh and prod.sh. Sourced, not run.

die() {
  echo "error: $*" >&2
  exit 1
}

# Reads KEY=value from an env file (no shell evaluation; last one wins).
env_value() { # file key
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | tail -n 1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# The server must be the only process writing its database (CLAUDE.md), so
# two stacks must never share a data directory. Prints the running containers
# outside compose project $2 that mount anything under directory $1.
data_users_elsewhere() { # data_dir project
  local id
  for id in $(docker ps -q); do
    docker inspect --format \
      '{{index .Config.Labels "com.docker.compose.project"}}|{{.Name}}|{{range .Mounts}}{{.Source}} {{end}}' "$id"
  done | awk -F'|' -v d="$1" -v p="$2" '
    $1 != p {
      n = split($3, m, " ")
      for (i = 1; i <= n; i++) if (m[i] == d || index(m[i], d "/") == 1) { print substr($2, 2); break }
    }'
}

guard_data() { # data_dir project
  local others
  others=$(data_users_elsewhere "$1" "$2")
  [ -z "$others" ] || die "$1 is in use by another stack (containers: $(tr "\n" " " <<<"$others")). Stop it first."
}
