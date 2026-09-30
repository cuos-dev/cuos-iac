#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
# Tests for iac/system-json.sh: run with `bash iac/test/system-json.test.sh`.
set -uo pipefail

# shellcheck source=../system-json.sh
source "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)/system-json.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
failures=0

# expect <name> <expected: changed|same|error> <merged json> <current json>
expect() {
  local name="$1" expected="$2" merged="$3" current="$4" got rc
  printf '%s' "${current}" >"${TMP}/current.json"
  system_json_would_change "${merged}" "${TMP}/current.json"
  rc=$?
  case "${rc}" in
    0) got=changed ;;
    1) got=same ;;
    *) got=error ;;
  esac
  if [[ "${got}" == "${expected}" ]]; then
    echo "ok   - ${name}"
  else
    echo "FAIL - ${name}: expected ${expected}, got ${got}"
    failures=$((failures + 1))
  fi
}

expect "identical"                       same    '{"a":1,"b":{"c":2}}' '{"a":1,"b":{"c":2}}'
expect "other key order"                 same    '{"a":1,"b":2}'       '{"b":2,"a":1}'
expect "other nested key order"          same    '{"o":{"x":1,"y":2}}' '{"o":{"y":2,"x":1}}'
expect "key only on the device"          same    '{"a":1}'             '{"a":1,"host_ssh_public_key":"k"}'
expect "nested key only on the device"   same    '{"o":{"x":1}}'       '{"o":{"x":1,"y":2}}'
expect "new key in the repository"       changed '{"a":1,"n":2}'       '{"a":1}'
expect "changed value"                   changed '{"a":2}'             '{"a":1}'
expect "changed nested value"            changed '{"o":{"x":2}}'       '{"o":{"x":1}}'
expect "array differs (replaced by merge)" changed '{"l":[1,2]}'       '{"l":[1]}'
expect "same array"                      same    '{"l":[1,2]}'         '{"l":[1,2]}'
expect "value set to null"               changed '{"a":null}'          '{"a":1}'
expect "current is not valid json"       error   '{"a":1}'             'not json'
expect "merged is not valid json"        error   'not json'            '{"a":1}'

if ((failures > 0)); then
  echo "${failures} test(s) failed"
  exit 1
fi
echo "all tests passed"
