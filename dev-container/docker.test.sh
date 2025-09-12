#!/bin/bash
# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------
# Path to YOUR docker wrapper script (the one that rewrites -v/--volume/--mount)
# If you prefer, uncomment the heredoc section further below to inline it here.
WRAP="${WRAP:-"${PWD}/docker"}"

if [ ! -x "${WRAP}" ]; then
  echo "Error: WRAP not found or not executable: ${WRAP}" >&2
  echo "Set WRAP to your wrapper path, e.g.: WRAP=/path/to/docker-wrapper.sh $0" >&2
  exit 1
fi

# Make wrapper call our exported functions instead of binaries
export HOST_MAP_BIN=cuos_host_path   # function (mock for 'cuos-host-path')
export DOCKER_REAL=docker            # function (mock for the real docker)
export DEBUG="${DEBUG:-0}"           # set 1 for wrapper debug logs

# -------------------------------------------------------------------
# Exported function mocks
# -------------------------------------------------------------------

# cuos_host_path: mock of 'cuos-host-path' (cannot export hyphenated function names)
# Behavior: takes container path ($1), resolves like realpath, and prints a host path.
# We prefix with /HOST to make assertions straightforward.
cuos_host_path() {
echo "HALLO" >&2
  set -euo pipefail
  local p="${1:-}"
  # Resolve path similarly to real cuos-host-path (which uses realpath)
  if command -v realpath >/dev/null 2>&1; then
    p="$(realpath -- "$p")"
  elif command -v readlink >/dev/null 2>&1; then
    p="$(readlink -f -- "$p" 2>/dev/null || printf '%s' "$PWD/${p#./}")"
  else
    p="$PWD/${p#./}"
  fi
  printf '/HOST%s' "$p"
  printf '/HOST%s' "$p" >&2
}
export -f cuos_host_path

# docker: mock of the real docker CLI (captured by DOCKER_REAL)
# Behavior: simply echoes the final argv the wrapper execs.
docker() {
  # Print arguments space-separated in a single line
  if [ "$#" -gt 0 ]; then
    printf '%s' "$1"; shift
    for a in "$@"; do printf ' %s' "$a"; done
  fi
  printf '\n'
}
export -f docker

# -------------------------------------------------------------------
# Tiny test framework
# -------------------------------------------------------------------
run_wrapper() {
  # Run wrapper with args, capture stdout; stderr is suppressed unless DEBUG=1
  "$WRAP" "$@"
}

pass=0; fail=0
expect() {
  local label="$1"; shift
  local EXPECTED="$1"; shift
  local GOT
  GOT="$(run_wrapper "$@")" || true
  if [ "$GOT" = "$EXPECTED" ]; then
    printf 'OK   %s\n' "$label"
    pass=$((pass+1))
  else
    printf 'FAIL %s\n  got:      %q\n  expected: %q\n' "$label" "$GOT" "$EXPECTED"
    fail=$((fail+1))
  fi
}

# Realpath of current directory (for relative path tests)
if command -v realpath >/dev/null 2>&1; then
  PWD_REAL="$(realpath .)"
elif command -v readlink >/dev/null 2>&1; then
  PWD_REAL="$(readlink -f . 2>/dev/null || pwd)"
else
  PWD_REAL="$(pwd)"
fi

# -------------------------------------------------------------------
# Tests
# -------------------------------------------------------------------

# 1) Absolute bind mount (-v separate)
expect "abs -v separate" \
  "run -v /HOST/data/work:/w alpine:3 ls /w" \
  run -v /data/work:/w alpine:3 ls /w

# 2) Absolute bind mount (--volume=… with :ro)
expect "--volume= abs with opts" \
  "run --volume=/HOST/data/x:/dst:ro busybox" \
  run --volume=/data/x:/dst:ro busybox

# 3) Named volume untouched
expect "named volume untouched" \
  "run -v myvol:/cache alpine" \
  run -v myvol:/cache alpine

# 4) Anonymous volume untouched
expect "anonymous volume untouched" \
  "run -v :/app alpine" \
  run -v :/app alpine

# 5) Relative path resolved by mapper
expect "relative --volume" \
  "run --volume /HOST${PWD_REAL}/cfg:/etc/myapp alpine" \
  run --volume ./cfg:/etc/myapp alpine

# 6) Combined short options cluster: -itv/home/user/data:/mnt:ro
expect "cluster -itv" \
  "run -i -t -v /HOST/home/user/data:/mnt:ro -p 80:80 alpine" \
  run -itv/home/user/data:/mnt:ro -p 80:80 alpine

# 7) --mount type=bind, src=./cfg
expect "--mount bind src=./cfg" \
  "run --mount type=bind,src=/HOST${PWD_REAL}/cfg,dst=/etc/app alpine" \
  run --mount 'type=bind,src=./cfg,dst=/etc/app' alpine

# 8) --mount type=volume untouched
expect "--mount volume untouched" \
  "run --mount type=volume,src=myvol,dst=/data alpine" \
  run --mount 'type=volume,src=myvol,dst=/data' alpine

# 9) End of options -- passthrough
expect "-- passthrough" \
  "run -- -v /x:/y weird -args" \
  run -- -v /x:/y weird -args

printf '\nSummary: %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1

# -------------------------------------------------------------------
# (Optional) Inline the wrapper here if you want a single-file test:
# Uncomment, paste your wrapper where marked, then set WRAP to that file.
# -------------------------------------------------------------------
# TMP="$(mktemp -d)"
# WRAP="$TMP/docker-wrap.sh"
# cat >"$WRAP" <<'EOF'
# # ----- PASTE YOUR DOCKER WRAPPER HERE -----
# # (Use the full wrapper with -v/--volume/--mount support we built)
# # ----- END WRAPPER -----
# EOF
# chmod +x "$WRAP"
# exec "$0"  # re-run tests with WRAP pointing to the inlined wrapper
