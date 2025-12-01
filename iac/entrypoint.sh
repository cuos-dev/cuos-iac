#!/bin/bash

SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

set -x
set -uo pipefail

trap 'echo "Broken pipe detected!"' PIPE

CONFIG_PATH="/system.json"
SOCKET_PATH="/var/run/cuos.sock"
REPO_DIR="/volume/repo"
REPO_DIR_SUBDIR=""
STATE_FILE="/volume/state.json"
SIGNING_KEYS_FILE="/volume/signing_keys"

export SYSTEM_CONFIG_PATH="${SYSTEM_CONFIG_PATH:-"/system.json"}"
export DOCKER_CONTEXT=default

DOCKERCOMPOSE="${SCRIPT_DIR}/docker-compose-host-paths.sh"
MERGECONFIGS="${SCRIPT_DIR}/merge-configs.sh"

set_error() {
  echo "Error: $*" >&2
  set_state \
    --arg error "$1" \
    '.iac_error = $error | .iac_error_date = (now | todate)'
}

report() {
  echo "[cuos-iac] $*" >&2
}

get_state() {
  jq -r "$@" "${STATE_FILE}"
}
set_state() {
  # disable xtrace in this function
  (
    set +x

    local new_state
    new_state="$(jq \
      "$@" \
      "${STATE_FILE}")" || exit "$?"
    echo "${new_state}" >"${STATE_FILE}"
  )
}
init_state() {
  if [[ ! -f "${STATE_FILE}" ]] || \
      ! jq . "${STATE_FILE}" >/dev/null 2>&1; then
    echo "{}" >"${STATE_FILE}"
  fi
  set_state '.last_iac_start = (now | todate)'
  if [[ "$(get_state '.iac_state')" != "updating" ]]; then
    set_state '.iac_state = "starting"'
  fi
}

do_update_ca_certificates() {
  if [ -d "/etc/ssl/certs" ]; then
    echo "Updating CA certificates..."
    update-ca-certificates --fresh
  fi
}

clone_or_pull_repo() {
  git_clone() {
    rm -rf "$REPO_DIR"

    local repo_url="$1"
    local repo_branch="${2:-""}"
    if [ -n "$repo_branch" ]; then
      git clone --recurse-submodules --branch "$repo_branch" "$repo_url" "$REPO_DIR" || return 1
    else
      git clone --recurse-submodules "$repo_url" "$REPO_DIR" || return 1
    fi
    report "Cloned repo from $repo_url"
    return 0
  }
  local repo_url
  repo_url="$(jq -r '.iac_repo_url // empty' "$CONFIG_PATH")"
  local repo_branch
  repo_branch="$(jq -r '.iac_repo_branch // empty' "$CONFIG_PATH")"
  if [ -z "$repo_url" ]; then
    report "Error: No repo URL provided."
    return 1
  fi
  if [ -d "$REPO_DIR/.git" ]; then
    # check if repo url changed
    local current_url
    current_url=$(git -C "$REPO_DIR" config --get remote.origin.url)
    if [ "$current_url" != "$repo_url" ]; then
      report "Repo URL changed, re-cloning..."
      git_clone "$repo_url" "$repo_branch" || return 1
    fi
    # check if repo is up to date
    last_commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
    if [ -n "$repo_branch" ]; then
      git -C "$REPO_DIR" checkout "$repo_branch" ||  git_clone "$repo_url" "$repo_branch" || return 1
    fi
    git -C "$REPO_DIR" pull >/dev/null || git_clone "$repo_url" "$repo_branch" || return 1
    git -C "$REPO_DIR" submodule sync --recursive || true
    git -C "$REPO_DIR" submodule update --init --recursive || true
    git -C "$REPO_DIR" submodule foreach --recursive 'git fetch --all' || true
    git -C "$REPO_DIR" submodule update --init --recursive || true
    commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
    if [ "$commit" == "$last_commit" ]; then
      echo "No changes detected: $commit"
      # no updates
      return 3
    fi
    report "Info: Detected new commit: $commit"
    return 0
  else
    git_clone "$repo_url" "$repo_branch" || return 1
    return 0
  fi
}

decrypt_files() {
  IAC_FILE_PASSPHRASE="$(jq -r '.system_file_password // empty' "$CONFIG_PATH")"
  export IAC_FILE_PASSPHRASE

  find "$REPO_DIR" \
    -type f \
    -iname \*.enc \
    -exec "${SCRIPT_DIR}/config-decrypt.sh" "{}" ";"

  export IAC_FILE_PASSPHRASE=

  local exclude_file
  exclude_file="$(git -C "$REPO_DIR" rev-parse --git-dir)/info/exclude"
  local enc_files
  enc_files="$(cd "$REPO_DIR" && find "." -type f -iname \*.enc | sed -e 's/\.enc$//g')"
  echo "${enc_files}" >"${exclude_file}"
}

verify_commit() {
  local signing_keys
  signing_keys="$(jq -r '(.iac_repo_signing_keys // []) | to_entries[] | "\(.key) \(.value)"' "$CONFIG_PATH")"

  if [[ -z "${signing_keys}" ]]; then
    return 0
  fi

  echo "${signing_keys}" >"${SIGNING_KEYS_FILE}"
  git -C "$REPO_DIR" config gpg.ssh.allowedSignersFile "${SIGNING_KEYS_FILE}"

  git -C "$REPO_DIR" verify-commit HEAD
  return "$?"
}

cuos_api() {
  local command="$1"
  local json_data="${2:-""}"
  if [[ ! -S $SOCKET_PATH ]]; then
    echo "Socket does not exist: $SOCKET_PATH"
    return 2
  fi
  if [[ "${json_data}" == "-" ]]; then
    json_data="$(cat)"
  fi

  # open file descritor for socat. Input from pipe, Output to stdout
  exec 3> >(socat - UNIX-CONNECT:$SOCKET_PATH)
  local socat_pid="$!"

  # Send a command
  echo "${json_data:-"{}"}" | jq -c --arg command "$command" '.command = $command' >&3
  # wait that socat exists
  wait -f "${socat_pid}"
  # close file descriptor and get return value of socat
  local return_code="$?"
  if [[ "${return_code}" != "0" ]]; then
    echo "socat exited with return code ${return_code}."
    return 1
  fi

  exec 3>&-

  return 0
}

hash_file() {
  file="$1"
  jsonkey=".${2:-""}"
  if [[ "$file" != "-" && ! -f "$file" ]]; then return 1; fi
  jq "${jsonkey}" "$file" | sha256sum | awk '{print $1}'
  return "$?"
}

are_json_files_different() {
  file1="$1"
  file2="$2"
  jsonkey="${3:-""}"

  local hash_file1
  if ! hash_file1=$(hash_file "${file1}" "${jsonkey}"); then
    report "Error: Invalid JSON file $file1."
    return 2
  fi
  local hash_file2
  if ! hash_file2=$(hash_file "${file2}" "${jsonkey}"); then
    report "Error: Invalid JSON file $file2."
    return 2
  fi

  if [ "$hash_file1" != "$hash_file2" ]; then
    return 0
  fi
  return 1
}

apply_system_json_if_changed() {
  local repo_system_json="${REPO_DIR}${REPO_DIR_SUBDIR}/system.json"
  if [ ! -f "$repo_system_json" ]; then
    return 1
  fi
  local merged_config
  merged_config="$("${MERGECONFIGS}" "${repo_system_json}")" || return 1

  local need_update_ca_certs=0
  if echo "${merged_config}" | are_json_files_different "-" "${CONFIG_PATH}" custom_ca_certs; then
    need_update_ca_certs=1
  fi

  if echo "${merged_config}" | are_json_files_different "-" "${CONFIG_PATH}"; then
    if [[ "${SYSTEM_TYPE}" == "cuos" ]]; then
      report "Info: Applying new system.json via socket..."
      echo "${merged_config}" | jq '{"config": .}' | cuos_api "update" "-"
    else # assuming local type
      report "Info: Applying new system.json directly..."
      echo "${merged_config}" >"${CONFIG_PATH}"
    fi
  else
    # no changes
    return 3
  fi

  # CA certificates might have changed, so we update them
  if [[ "${need_update_ca_certs}" == "1" ]]; then
    do_update_ca_certificates
  fi
  return 0
}

run_docker_compose_build() {
  local compose_file="${REPO_DIR}${REPO_DIR_SUBDIR}/docker-compose.yml"
  if [ ! -f "$compose_file" ]; then
    report "Error: No docker-compose.yml found in repo."
    return 1
  fi
  # resolve symlinks to get the absolute path
  compose_file="$(realpath "$compose_file")"
  echo "Running docker-compose from $compose_file..."
  if ! "$DOCKERCOMPOSE" -f "$compose_file" config >/dev/null 2>&1; then
    report "Error: Invalid docker-compose file: $compose_file"
    return 1
  fi
  # Run docker-compose with the resolved absolute path
  echo "Starting services with docker-compose..."
  export COMPOSE_PROJECT_NAME="${IAC_COMPOSE_PROJECT_NAME:-"iac"}"

  "$DOCKERCOMPOSE" -f "$compose_file" build --pull || {
    report "Error: Failed to build images with docker-compose."
    return 1
  }
}

run_docker_compose() {
  local compose_file="${REPO_DIR}${REPO_DIR_SUBDIR}/docker-compose.yml"
  if [ ! -f "$compose_file" ]; then
    report "Error: No docker-compose.yml found in repo."
    return 1
  fi
  # resolve symlinks to get the absolute path
  compose_file="$(realpath "$compose_file")"
  echo "Running docker-compose from $compose_file..."
  if ! "$DOCKERCOMPOSE" -f "$compose_file" config >/dev/null 2>&1; then
    report "Error: Invalid docker-compose file: $compose_file"
    return 1
  fi
  # Run docker-compose with the resolved absolute path
  echo "Starting/Updating Docker Compose services."
  export COMPOSE_PROJECT_NAME="${IAC_COMPOSE_PROJECT_NAME:-"iac"}"

  "$DOCKERCOMPOSE" -f "$compose_file" pull -q || {
    report "Error: Failed to pull images with docker-compose."
    return 1
  }
  docker_compose_check_digests "$compose_file" || {
    report "Error: Image digest check failed."
    return 1
  }

  "$DOCKERCOMPOSE" \
    -f "$compose_file" \
    up -d \
    --remove-orphans \
    --pull never

  docker image prune -f --filter "until=96h" || true
  docker builder prune -f --filter "until=240h" || true

  report "Started/Updated Docker Compose services."
}

docker_compose_check_digests() {
  local compose_file="$1"

  images=$("$DOCKERCOMPOSE" -f "$compose_file" config | yq -c '.services[]' -)

  while IFS= read -r image; do
    image_name=$(echo "${image}" | yq -r '.image')
    expected_digest=$(echo "${image}" | jq -r '."x-digest" // empty')
    actual_digest=$(docker inspect --format='{{index .RepoDigests 0}}' "${image_name}" | cut -d'@' -f2)

    if [[ "$expected_digest" == "null" || -z "$expected_digest" ]]; then
      echo "No digest specified for ${image_name}. Skipping check."
    elif [[ "$actual_digest" != "$expected_digest" ]]; then
      echo "Digest mismatch for ${image_name}"
      echo "  Expected: $expected_digest"
      echo "  Actual:   $actual_digest"
      return 1
    fi
  done <<< "$images"
  return 0
}

isleep() {
  sleep "$@" &
  local sleep_pid="$!"

  wait -f "${sleep_pid}"
}

counter=0

check_update() {
  if [ ! -f "$CONFIG_PATH" ]; then
    report "Error: $CONFIG_PATH not found, waiting..." >&2
    isleep 10
    exit 1
  fi
  clone_or_pull_repo
  state="$?"
  if ! verify_commit; then
    report "Error: Could not verify last commit. Skip applying changes." >&2
    set_state '.iac_state = "verification-failed"'

  # repo is there:
  elif [[ "${state}" != "1" ]]; then

    REPO_DIR_SUBDIR="$(jq -r '.iac_repo_subdir // empty' "$CONFIG_PATH")"
    if [ -n "$REPO_DIR_SUBDIR" ]; then
      REPO_DIR_SUBDIR="/$REPO_DIR_SUBDIR"
    fi
    system_json_changed="-1"
    # repo has update / is new:
    if [[ "${state}" == "0" ]]; then
      commit="$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")"
      set_state --arg commit "${commit}" '.iac_commit = $commit'

      decrypt_files

      apply_system_json_if_changed
      system_json_changed="$?"
      set_state '.last_iac_update = (now | todate)'
      counter=0

      run_docker_compose_build
    fi
    if [[ "${system_json_changed}" == "0" ]]; then
      run_docker_compose --force-recreate
    else
      run_docker_compose
    fi

    # poll os update, only needed if digest is empty
    OS_DIGEST="$(jq -r '.os_image_digest // empty' "${CONFIG_PATH}")"
    if [[ "${OS_DIGEST}" == "" && "${SYSTEM_TYPE}" == "cuos" ]]; then
      counter="$((counter + 1))"
      # every 2h:
      if [[ "${counter}" -ge 8 ]]; then
        cuos_api update
        counter=0
      fi
# TODO: Self update
    fi
    set_state '.iac_state = "idle"'
  else
    report "Error: Could not clone/pull repo." >&2
    set_state '.iac_state = "error"'
  fi
  set_state '.last_iac_update_check = (now | todate)'

  POLL_INTERVAL=$(jq -r 'if .iac_manual_updates == true then "infinity"
    else (.iac_poll_interval // 21600 | tostring) end' "$CONFIG_PATH")

  # randomize the poll interval, to reduce concurrent traffic on update servers:
  if [[ "${POLL_INTERVAL}" != "infinity" && "${POLL_INTERVAL}" -gt 1200 ]]; then
    local poll_rand
    poll_rand="$(( RANDOM % 300 ))"
    POLL_INTERVAL="$(( POLL_INTERVAL - poll_rand ))"
  fi


  # if sleep was killed, than force direct os update
  isleep "$POLL_INTERVAL" || counter=999
  set_state '.iac_state = "updating"'
}

# sleep randomly, to reduce concurrent traffic on update servers:
sleep_randomly() {
  isleep "$(( RANDOM % 900 ))"
}

sleep_on_manual_updates() {
  # no sleep if system is updating:
  if [[ ! -d "${REPO_DIR}/.git" || \
      "$(get_state '.iac_state')" == "updating" ]]; then
    return
  fi
  if jq -e '.iac_manual_updates == true' "${CONFIG_PATH}" > /dev/null; then
    set_state '.iac_state = "idle"'
    isleep infinity || counter=999
    set_state '.iac_state = "updating"'
  else
    sleep_randomly
  fi
}

# Start a UNIX socket server that executes /api/trigger for each connection.
# This makes the `trigger` script callable via the socket at ${SOCKET_PATH}.
IAC_SOCKET_PATH="/socket/cuos-iac.sock"
IAC_SOCKET_DIR=$(dirname "${IAC_SOCKET_PATH}")
mkdir -p "${IAC_SOCKET_DIR}"
rm -f "${IAC_SOCKET_PATH}" || true

start_socket() {
  # Use fork to handle multiple connections.
  socat UNIX-LISTEN:"${IAC_SOCKET_PATH}",fork,mode=666,unlink-close EXEC:"/api/trigger" &

  IAC_SOCAT_PID="$!"
  # Ensure socat is stopped when the container exits.
  trap 'echo "Stopping socat"; kill "${IAC_SOCAT_PID}" 2>/dev/null || true' EXIT INT TERM
}


init_state

do_update_ca_certificates

start_socket

sleep_on_manual_updates

while true; do
  check_update
done
