#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Runs `npm test` and `npm run build` in every tracked Node package that defines them (the fleet agent and server,
# the backup container, the web UIs). The placeholder "no test specified" counts as no test. Used by CI, runs the same locally:
#   .github/scripts/node-checks.sh
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2
status=0
ran=0

while IFS= read -r pkg; do
  dir="$(dirname "${pkg}")"
  test_cmd="$(jq -r '.scripts.test // empty' "${pkg}")"
  build_cmd="$(jq -r '.scripts.build // empty' "${pkg}")"
  [[ "${test_cmd}" == *"no test specified"* ]] && test_cmd=""
  [[ -z "${test_cmd}" && -z "${build_cmd}" ]] && continue

  echo "::group::${dir} ($([[ -n "${test_cmd}" ]] && echo -n 'test ')$([[ -n "${build_cmd}" ]] && echo -n 'build'))"
  (
    cd "${dir}" || exit 1
    if [[ -f package-lock.json ]]; then
      npm ci --no-audit --no-fund || exit 1
    else
      npm install --no-audit --no-fund || exit 1
    fi
    if [[ -n "${test_cmd}" ]]; then npm test || exit 1; fi
    if [[ -n "${build_cmd}" ]]; then npm run build || exit 1; fi
  ) || {
    status=1
    echo "::error file=${pkg}::${dir} failed"
  }
  echo "::endgroup::"
  ran=$((ran + 1))
done < <(git ls-files '*package.json')

if (( ran == 0 )); then
  echo "No Node package with tests or a build."
elif (( status == 0 )); then
  echo "OK: ${ran} Node package(s) pass."
fi
exit "${status}"
