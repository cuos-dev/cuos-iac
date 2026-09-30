#!/bin/bash
# SPDX-License-Identifier: Apache-2.0
#
# git credential helper: git-credentials.sh configures it as "!git-credential-env.sh <n>".
# Answers `get` with IAC_GIT_USER_<n> / IAC_GIT_TOKEN_<n> from the environment; every other operation is ignored.
index="${1:-}"
operation="${2:-}"
[[ "${operation}" == "get" ]] || exit 0
cat >/dev/null   # the request on stdin is not needed
user_var="IAC_GIT_USER_${index}"
token_var="IAC_GIT_TOKEN_${index}"
[[ -n "${!token_var:-}" ]] || exit 0
echo "username=${!user_var:-x-access-token}"
echo "password=${!token_var}"
