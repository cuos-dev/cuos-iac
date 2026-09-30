#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# Credentials for private git remotes (the IaC repository and its submodules).
# Meant to be sourced (entrypoint.sh, tests).
#
# system.json:
#   "iac_git_credentials": [
#     { "url": "https://github.com/your-org/", "username": "x-access-token", "token": "..." }
#   ]
#
# A token is used for every https remote that starts with "url". git asks the helpers in configuration order and
# takes the first answer, so the entries are configured longest url first: the most specific entry wins. The URLs in
# iac_repo_url and .gitmodules stay plain, so the same repository works with other credentials or ssh elsewhere,
# and the token can live in the encrypted system_secrets.json.
#
# The entries are handed to git through GIT_CONFIG_COUNT/GIT_CONFIG_KEY_n/GIT_CONFIG_VALUE_n (git >= 2.31) and a
# credential helper that reads the secret from the environment. Nothing is written to a .git/config, and the token is
# neither part of a URL nor of a command line, so it does not show up in git's messages or in `set -x` traces.

# git_credentials_export <system.json> [helper]
# Exports the git configuration for all iac_git_credentials entries of <system.json>.
# Entries that are not https urls or lack a token are skipped with a warning (without the token).
git_credentials_export() {
  local config="$1"
  local helper="${2:-${SCRIPT_DIR:-.}/git-credential-env.sh}"
  local xtrace=0
  [[ $- == *x* ]] && xtrace=1
  set +x

  local count entries i url user token n
  entries="$(jq -c '(.iac_git_credentials // []) | sort_by(-((.url // "") | length)) | .[]' "${config}" 2>/dev/null)" || entries=""
  n="${GIT_CONFIG_COUNT:-0}"
  count=0
  if [[ -n "${entries}" ]]; then
    while IFS= read -r entry; do
      url="$(jq -r '.url // empty' <<<"${entry}")"
      user="$(jq -r '.username // "x-access-token"' <<<"${entry}")"
      token="$(jq -r '.token // empty' <<<"${entry}")"
      if [[ ! "${url}" =~ ^https?://[^/]+/ ]] || [[ -z "${token}" ]]; then
        echo "[cuos-iac] Warning: ignoring an iac_git_credentials entry (needs an http(s) url ending with / and a token)." >&2
        continue
      fi
      i="${count}"
      export "IAC_GIT_USER_${i}=${user}" "IAC_GIT_TOKEN_${i}=${token}"
      export "GIT_CONFIG_KEY_${n}=credential.${url}.helper" "GIT_CONFIG_VALUE_${n}=!${helper} ${i}"
      n=$((n + 1))
      count=$((count + 1))
    done <<<"${entries}"
  fi
  if ((count > 0)); then
    # the path decides which entry applies
    export "GIT_CONFIG_KEY_${n}=credential.useHttpPath" "GIT_CONFIG_VALUE_${n}=true"
    n=$((n + 1))
    export GIT_CONFIG_COUNT="${n}"
    # never wait for a password on a terminal that does not exist
    export GIT_TERMINAL_PROMPT=0
  fi
  ((xtrace)) && set -x
  return 0
}
