#!/bin/bash
set -uo pipefail
set -x

trap 'echo "Broken pipe detected!"' PIPE

CONFIG_PATH="/system.json"
SOCKET_PATH="/var/run/cuos.sock"
REPO_DIR="/volume/repo"
REPO_DIR_SUBDIR=""
STATE_FILE="/volume/state.json"

set_error() {
    echo "Error: $*" >&2
    set_state \
        --arg error "$1" \
        '.iac_error = $error | .iac_error_date = (now | todate)'
}

get_state() {
    jq "$@" "${STATE_FILE}"
}
set_state() {
    local new_state
    new_state="$(jq \
        "$@" \
        "${STATE_FILE}")" || exit "$?"
    echo "${new_state}" >"${STATE_FILE}"
}
init_state() {
    if [[ ! -f "${STATE_FILE}" ]] || \
            ! jq . "${STATE_FILE}" >/dev/null 2>&1; then
        echo "{}" >"${STATE_FILE}"
    fi
    set_state '.last_iac_start = (now | todate)'
    set_state '.iac_state = "updating"'
}

do-update-ca-certificates() {
    if [ -d "/etc/ssl/certs" ]; then
        echo "[iac-manager] Updating CA certificates..." >&2
        update-ca-certificates --fresh
    fi
}

clone_or_pull_repo() {
    git_clone() {
        rm -rf "$REPO_DIR"

        local repo_url="$1"
        local repo_branch="${2:-""}"
        if [ -n "$repo_branch" ]; then
            git clone --branch "$repo_branch" "$repo_url" "$REPO_DIR" || return 1
        else
            git clone "$repo_url" "$REPO_DIR" || return 1
        fi
        echo "[iac-manager] Cloned repo from $repo_url" >&2
        return 0
    }
    local repo_url
    repo_url="$(jq -r '.iac_repo_url // empty' "$CONFIG_PATH")"
    local repo_branch
    repo_branch="$(jq -r '.iac_repo_branch // empty' "$CONFIG_PATH")"
    if [ -z "$repo_url" ]; then
        echo "[iac-manager] No repo URL provided." >&2
        return 1
    fi
    if [ -d "$REPO_DIR/.git" ]; then
        # check if repo url changed
        local current_url
        current_url=$(git -C "$REPO_DIR" config --get remote.origin.url)
        if [ "$current_url" != "$repo_url" ]; then
            echo "[iac-manager] Repo URL changed, re-cloning..." >&2
            git_clone "$repo_url" "$repo_branch" || return 1
        fi
        # check if repo is up to date
        last_commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
        if [ -n "$repo_branch" ]; then
            git -C "$REPO_DIR" checkout "$repo_branch" ||  git_clone "$repo_url" "$repo_branch" || return 1
        fi
        git -C "$REPO_DIR" pull >/dev/null || git_clone "$repo_url" "$repo_branch" || return 1
        commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
        if [ "$commit" == "$last_commit" ]; then
            echo "[iac-manager] No changes detected: $commit" >&2
            # no updates
            return 3
        fi
        echo "[iac-manager] Detected new commit: $commit" >&2
        return 0
    else
        git_clone "$repo_url" "$repo_branch" || return 1
        return 0
    fi
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
    if [[ ! -f "$file" ]]; then return 1; fi
    jq "${jsonkey}" "$file" | sha256sum | awk '{print $1}'
    return "$?"
}

are_json_files_different() {
    file1="$1"
    file2="$2"
    jsonkey="${3:-""}"

    local hash_file1
    if ! hash_file1=$(hash_file "${file1}" "${jsonkey}"); then
        echo "[iac-manager] Invalid JSON file $file1." >&2
        return 2
    fi
    local hash_file2
    if ! hash_file2=$(hash_file "${file2}" "${jsonkey}"); then
        echo "[iac-manager] Invalid JSON file $file2." >&2
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
        return
    fi
    local need_update_ca_certs=0
    if are_json_files_different "${repo_system_json}" "${CONFIG_PATH}" custom_ca_certs; then
        need_update_ca_certs=1
    fi

    if are_json_files_different "${repo_system_json}" "${CONFIG_PATH}"; then
        echo "[iac-manager] Applying new system.json via socket..." >&2
        jq '{"config": .}' "$repo_system_json" | cuos_api "reinit" "-"
        # TODO check result
    fi

    # CA certificates might have changed, so we update them
    if [[ "${need_update_ca_certs}" == "1" ]]; then
        do_update_ca_certificates
    fi
}

run_docker_compose() {
    local compose_file="${REPO_DIR}${REPO_DIR_SUBDIR}/docker-compose.yml"
    if [ ! -f "$compose_file" ]; then
        echo "[iac-manager] No docker-compose.yml found in repo." >&2
        return
    fi
    # resolve symlinks to get the absolute path
    compose_file=$(realpath "$compose_file")
    echo "[iac-manager] Running docker-compose from $compose_file..." >&2
    if ! docker compose -f "$compose_file" config >/dev/null 2>&1; then
        echo "[iac-manager] Invalid docker-compose file: $compose_file" >&2
        return 1
    fi
    # Run docker-compose with the resolved absolute path
    echo "[iac-manager] Starting services with docker-compose..." >&2
    export COMPOSE_PROJECT_NAME="iac"

    docker compose -f "$compose_file" pull -q || {
        echo "[iac-manager] Failed to pull images with docker-compose." >&2
        return 1
    }
    docker_compose_check_digests "$compose_file" || {
        echo "[iac-manager] Image digest check failed." >&2
        return 1
    }

    docker compose \
      -f "$compose_file" \
      up -d \
      --pull never

    # remove old images
    docker image prune -f || true
    docker system prune -f --volumes || true

}

docker_compose_check_digests() {
  local compose_file="$1"

  images=$(docker compose -f "$compose_file" config | yq -c '.services[]' -)

  while IFS= read -r image; do
    image_name=$(echo "${image}" | yq -r '.image')
    expected_digest=$(echo "${image}" | jq -r '.digest // empty')
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

init_state

do-update-ca-certificates

counter=0
while true; do
    if [ ! -f "$CONFIG_PATH" ]; then
        echo "[iac-manager] $CONFIG_PATH not found, waiting..." >&2
        sleep 10
        continue
    fi
    state="$(clone_or_pull_repo)"
    # repo is there:
    if [[ "${state}" != "1" ]]; then
        REPO_DIR_SUBDIR=$(jq -r '.iac_repo_subdir // empty' "$CONFIG_PATH")
        if [ -n "$REPO_DIR_SUBDIR" ]; then
            REPO_DIR_SUBDIR="/$REPO_DIR_SUBDIR"
        fi
        # repo has update / is new:
        if [[ "${state}" == "0" ]]; then
            commit=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null || echo "")
            set_state --arg commit "${commit}" '.iac_commit = $commit'
            apply_system_json_if_changed
            set_state '.last_iac_update = (now | todate)'
            counter=0
        fi
        run_docker_compose

        # poll os update, only needed if digest is empty
        OS_DIGEST="$(jq -r '.os_image_digest // empty' "${CONFIG_PATH}")"
        if [[ "${OS_DIGEST}" == "" ]]; then
            counter="$((counter + 1))"
	    # every 2h:
            if [[ "${counter}" -ge 8 ]]; then
                cuos_api update
                counter=0
            fi
        fi
    fi
    set_state '.last_iac_update_check = (now | todate)'
    POLL_INTERVAL=$(jq -r '.iac_poll_interval // 900' "$CONFIG_PATH")
    # if sleep was killed, than force direct os update
    set_state '.iac_state = "idle"'
    sleep "$POLL_INTERVAL" || counter=999
    set_state '.iac_state = "updating"'
done
