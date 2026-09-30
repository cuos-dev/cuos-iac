#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# Helpers to decide whether the system.json of the repository has to be applied.
# Meant to be sourced (entrypoint.sh, tests).

# Would applying the merged repository config change the current system.json?
#
#   system_json_would_change <merged-config-json> <current-system.json>
#
# Returns 0 if applying changes something, 1 if not, 2 if a file is not valid JSON.
#
# The OS does not replace its config, it stores "current * update" (a recursive jq
# merge, see cuos api update). The question is therefore whether that merge differs
# from the current config, compared with sorted keys. Comparing a hash of the plain
# "jq ." output reports a change for
#  - a different key order (the merged config of the repository is ordered by first
#    appearance in the includes, the device file keeps its own order and appends
#    new keys), and
#  - keys that exist only on the device (installer, cloud-init, patches). The merge
#    never removes them, so such a system would never be seen as up to date.
# Every new commit then applied the config and force-recreated all containers.
system_json_would_change() {
  local merged="$1"
  local current="$2"
  local before after
  before="$(jq -S . "${current}" 2>/dev/null | sha256sum)" || return 2
  after="$(jq -S -s '.[0] * .[1]' "${current}" <(printf '%s' "${merged}") 2>/dev/null | sha256sum)" || return 2
  # a pipeline reports the status of sha256sum only: check that jq could read the files
  jq -e . "${current}" >/dev/null 2>&1 || return 2
  printf '%s' "${merged}" | jq -e . >/dev/null 2>&1 || return 2
  [[ "${before}" != "${after}" ]]
}
