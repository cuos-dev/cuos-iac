#!/usr/bin/bash

set -euo pipefail

LABEL="${LABEL:-dev.cuos.iac}"
export VOLUME_MNT="${VOLUME_MNT:-/volume}"

get_container_id() {
  local cid
  cid="$(docker ps --filter "id=$(hostname)" --format "{{.ID}}")"
  if [[ -z "${cid}" ]]; then
    local candidates
    candidates="$(docker ps -q --filter "label=$LABEL")"
    if [ -z "$candidates" ]; then
      echo "ERROR: No running container found with label '$LABEL'." >&2
      exit 1
    fi
    cid="$(printf '%s\n' "$candidates" | head -n1)"
  fi

  echo "${cid}"
}

get_host_repo_path() {
  local cid
  cid="$(get_container_id)"

  # Resolve host path: Works for both bind and volume mounts
  local info
  info="$(docker inspect "${cid}" --format '{{range .Mounts}}{{if eq .Destination "'"$VOLUME_MNT"'"}}{{println .Type "|" .Source "|" .Name}}{{end}}{{end}}')"
  if [ -z "$info" ]; then
    echo "ERROR: Mount '$VOLUME_MNT' not found in container $CID." >&2
    exit 2
  fi

  local bind_type
  bind_type="$(printf '%s' "$info" | head -n1 | cut -d'|' -f1 | tr -d ' ')"
  local src
  src="$( printf '%s' "$info" | head -n1 | cut -d'|' -f2 | tr -d ' ')"
  local name
  name="$(printf '%s' "$info" | head -n1 | cut -d'|' -f3 | tr -d ' ')"

  local host_repo_path
  case "$bind_type" in
    bind)
      host_repo_path="$src"
      ;;
    volume)
      if [ -n "$src" ] && [ -d "$src" ]; then
        host_repo_path="$src"
      else
        host_repo_path="$(docker volume inspect "$name" --format '{{.Mountpoint}}')"
      fi
      ;;
    *)
      echo "ERROR: Unsupported mount type '$bind_type' for '$VOLUME_MNT'." >&2
      exit 3
      ;;
  esac

  echo "${host_repo_path}"
}

HOST_REPO_PATH="$(get_host_repo_path)"
export HOST_REPO_PATH

COMPOSE_FILE="${1:-}"
shift
if [[ "${COMPOSE_FILE}" == "-f" ]]; then
  COMPOSE_FILE="${1:-}"
  shift
fi

RENDERED="$(docker compose -f "${COMPOSE_FILE}" config)"

REWRITTEN="$(
  printf '%s' "$RENDERED" \
  | yq -y '
      def walk(f):
        . as $in
        | if type == "object" then
            with_entries(
              if .key == "context"
              then .
              else (.value |= (.value | walk(f)))
              end
            )
          elif type == "array" then
            map(walk(f))
          else
            f
          end;
      walk(
        if type == "string"
        then sub("^" + (env.VOLUME_MNT); env.HOST_REPO_PATH)
        else .
        end
      )
    '
)"

# === BEHAVIOR ===
# - If called with "config", print the rewritten config (to stdout) and exit.
# - Otherwise, feed the rewritten config to `docker compose -f - ...`.
if [ "${1:-}" = "config" ]; then
  printf '%s\n' "$REWRITTEN"
  exit 0
fi

#if [ $# -eq 0 ]; then
#  # Default action if no args passed:
#  set -- up -d
#fi

cd "$(dirname "${COMPOSE_FILE}")"

# Feed rewritten YAML via stdin:
printf '%s\n' "$REWRITTEN" | docker compose -f - "$@"
