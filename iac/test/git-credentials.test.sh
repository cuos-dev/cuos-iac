#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Tests for iac/git-credentials.sh: run with `bash iac/test/git-credentials.test.sh`.
set -uo pipefail

IAC_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export SCRIPT_DIR="${IAC_DIR}"   # used by git-credentials.sh to find the credential helper
# shellcheck source=../git-credentials.sh
source "${IAC_DIR}/git-credentials.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
# subshells cannot change variables: failures are counted in a file
touch "${TMP}/failed"
# an unrelated global git config must not influence the tests
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

check() { # <name> <expected> <actual>
  if [[ "$2" == "$3" ]]; then echo "ok   - $1"; else echo "FAIL - $1: expected '$2', got '$3'"; echo "$1" >>"${TMP}/failed"; fi
}

# ask git for the credentials of a remote, like a fetch would: prints "user:password" or "none"
credentials_for() { # <host> <path>
  local out
  out="$(printf 'protocol=https\nhost=%s\npath=%s\n\n' "$1" "$2" | git credential fill 2>/dev/null)" || { echo none; return; }
  echo "$(sed -n 's/^username=//p' <<<"${out}"):$(sed -n 's/^password=//p' <<<"${out}")"
}

# each case runs in a subshell: the exported variables must not leak into the next one
(
  cat >"${TMP}/one.json" <<'JSON'
{ "iac_git_credentials": [
  { "url": "https://github.com/acme/", "username": "bot", "token": "tok-acme" },
  { "url": "https://github.com/acme/private/", "username": "deploy", "token": "tok-private" },
  { "url": "https://git.example.org/", "token": "tok-example" }
] }
JSON
  git_credentials_export "${TMP}/one.json"
  check "entry for an organisation"          "bot:tok-acme"               "$(credentials_for github.com acme/tools.git)"
  check "most specific entry wins"           "deploy:tok-private"         "$(credentials_for github.com acme/private/x.git)"
  check "default username"                   "x-access-token:tok-example" "$(credentials_for git.example.org any/repo.git)"
  check "other organisation gets nothing"    "none"                       "$(credentials_for github.com other/repo.git)"
  check "other host gets nothing"            "none"                       "$(credentials_for gitlab.com acme/repo.git)"
)

(
  echo '{}' >"${TMP}/none.json"
  git_credentials_export "${TMP}/none.json"
  check "no entries: nothing is exported" "unset" "${GIT_CONFIG_COUNT-unset}"
  git_credentials_export "${TMP}/missing.json"
  check "missing config file is not an error" "unset" "${GIT_CONFIG_COUNT-unset}"
)

(
  cat >"${TMP}/bad.json" <<'JSON'
{ "iac_git_credentials": [
  { "url": "git@github.com:acme/", "token": "tok-ssh" },
  { "url": "https://github.com/acme/" },
  { "url": "https://github.com/ok/", "token": "tok-ok" }
] }
JSON
  warnings="$(git_credentials_export "${TMP}/bad.json" 2>&1 >/dev/null)"
  check "invalid entries are skipped with a warning" "2" "$(grep -c 'ignoring an iac_git_credentials entry' <<<"${warnings}")"
  check "warnings never contain the token"           "0" "$(grep -c 'tok-' <<<"${warnings}")"
  git_credentials_export "${TMP}/bad.json" 2>/dev/null
  check "valid entry still works"                    "x-access-token:tok-ok" "$(credentials_for github.com ok/r.git)"
)

(
  # a configuration that is already set (GIT_CONFIG_COUNT) is kept
  export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.abbrev GIT_CONFIG_VALUE_0=12
  git_credentials_export "${TMP}/one.json"
  check "existing GIT_CONFIG_* entries are kept" "12" "$(git config --get core.abbrev)"
  check "credentials still work next to them"    "bot:tok-acme" "$(credentials_for github.com acme/x.git)"
)

(
  # the manager runs with `set -x`: the token must not appear in the trace, and tracing must be restored
  trace="$( { set -x; git_credentials_export "${TMP}/one.json"; case $- in *x*) echo "TRACE-ON" >&2 ;; esac; } 2>&1 >/dev/null )"
  check "token not in the xtrace output" "0" "$(grep -c 'tok-' <<<"${trace}")"
  check "xtrace is switched on again"    "1" "$(grep -cx 'TRACE-ON' <<<"${trace}")"
)

failures="$(wc -l <"${TMP}/failed")"
if ((failures > 0)); then
  echo "${failures} test(s) failed"
  exit 1
fi
echo "all tests passed"
