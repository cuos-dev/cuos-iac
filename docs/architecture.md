# Architecture

This document describes the internal architecture of CuOS IaC — how the components fit together, what happens at each stage of the lifecycle, and how state is managed.

---

## Components

```
/workspace/iac/
├── Dockerfile                     # Container image definition
├── entrypoint.sh                  # Main process (polling loop, orchestration)
├── merge-configs.sh               # JSON config composition with #include support
├── config-decrypt.sh              # AES-256-CBC file decryption
├── docker-compose-host-paths.sh   # Docker Compose path translation wrapper
└── api/
    ├── trigger                    # Socket API dispatcher
    ├── stop                       # Compose shutdown handler
    ├── pre_update                 # Pre-update lifecycle hook
    └── post_update                # Post-update lifecycle hook
```

---

## Container environment

The IaC container runs as a long-lived process with access to:

| Mount | Purpose |
|-------|---------|
| `/var/run/docker.sock` | Control the Docker daemon on the host |
| `/system.json` (read-only) | Read host configuration |
| `/var/run/cuos.sock` | Communicate with CuOS (when running on CuOS) |
| `iac-volume:/volume` | Persistent state: cloned repo, state file, signing keys |
| `iac-socket:/socket` | Exposes the IaC Unix socket to other containers |
| `/root/.docker/config.json` (read-only) | Docker registry credentials |
| `/usr/local/share/ca-certificates/custom` (read-only) | Custom CA certificate source |

The container root filesystem is **read-only**. Writable areas are limited to:
- `/volume` — Docker volume for persistent state
- `/tmp` — tmpfs (64 MB)
- `/etc/ssl/certs` — tmpfs (16 MB, for CA cert updates)

---

## Startup sequence

```
entrypoint.sh starts
    │
    ├─► init_state()           Create /volume/state.json if missing
    │                          Set iac_state = "starting"
    │
    ├─► do_update_ca_certs()   Install custom_ca_certs from system.json
    │
    ├─► start_socket()         Start socat listening on /socket/cuos-iac.sock
    │                          Each connection forks /api/trigger
    │
    └─► sleep_on_manual_updates()
            │
            ├─ if iac_manual_updates=true and repo exists:
            │      wait for socket trigger, then enter update loop
            │
            └─ else:
                   sleep random 0–180s (jitter for fleet deployments)
                   then enter update loop
```

---

## Update loop

The main loop runs `check_update()` → `perform_update()` → sleep → repeat.

```
perform_update()
    │
    ├─► clone_or_pull_repo()
    │       Clone (first run) or pull (subsequent)
    │       If repo URL changed → re-clone
    │       Return code:
    │         0 = new commit detected
    │         1 = error
    │         3 = no changes (up to date)
    │
    ├─► verify_commit()
    │       If iac_repo_signing_keys is set:
    │         Verify HEAD is SSH-signed by a listed key
    │         Return 1 (abort) if verification fails
    │
    ├─► [if new commit]
    │       decrypt_files()
    │           Find *.enc files, decrypt each with config-decrypt.sh
    │           Add plaintext filenames to .git/info/exclude
    │
    │       apply_system_json_if_changed()
    │           Merge repo/system.json with merge-configs.sh
    │           Hash-compare with current /system.json
    │           If changed:
    │             CuOS mode: send to CuOS via socket (update:json)
    │             Standalone mode: write directly to /system.json
    │           Return:
    │             0 = applied (changed)
    │             1 = no system.json in repo
    │             2 = apply failed
    │             3 = no change
    │
    │       run_docker_compose_build()
    │           Validate docker-compose.yml
    │           docker compose build --pull
    │
    │       run_docker_compose()
    │           docker compose pull
    │           Verify x-digest for each image
    │           docker compose up -d --remove-orphans
    │           (--force-recreate if system.json changed)
    │           Prune old images (>96h) and build cache (>240h)
    │
    └─► [if no new commit]
            run_docker_compose() only
            (non-pinned images may have received updates)

    Update state.json throughout with current status and commit hash
```

---

## Path translation (docker-compose-host-paths.sh)

Docker Compose bind mounts require host-absolute paths. When the IaC container runs with `/volume` as a Docker volume (not a bind mount), paths inside the container like `/volume/repo` must be translated to the actual host-side mount point before being passed to `docker compose`.

```
docker-compose-host-paths.sh -f docker-compose.yml up -d
    │
    ├─► Detect own container ID (hostname or label dev.cuos.iac)
    ├─► Inspect container mounts to find /volume destination
    │       bind → use source path directly
    │       volume → docker volume inspect to get mountpoint
    ├─► Render docker-compose config (resolving all includes)
    ├─► Rewrite all path strings: s|^/volume|<host-path>|
    └─► Pipe rewritten config to: docker compose -f - <args>
```

This wrapper is transparent — it accepts all the same arguments as `docker compose`.

---

## Socket API (socat + /api/trigger)

The IaC container exposes a Unix socket at `/socket/cuos-iac.sock`. A `socat` server listens and forks `/api/trigger` for each incoming connection.

```
client sends JSON → socat forks /api/trigger → reads app_command → dispatches
```

`/api/trigger` reads either:
- A positional argument: `trigger update`
- A JSON object from stdin: `{"app_command": "update"}`

See [API Reference](api.md) for all supported commands.

---

## State file

`/volume/state.json` tracks the IaC lifecycle. It is updated atomically using `jq`.

| Field | Type | Description |
|-------|------|-------------|
| `iac_state` | string | Current state (see below) |
| `last_iac_start` | ISO datetime | When the container last started |
| `last_iac_update_check` | ISO datetime | Last time an update check ran |
| `last_iac_update` | ISO datetime | Last successful update |
| `iac_commit` | string | Git commit hash of last applied update |
| `iac_error` | string | Last error message (if any) |
| `iac_error_date` | ISO datetime | When the last error occurred |

### State values

| State | Meaning |
|-------|---------|
| `starting` | Container just started, first update not yet done |
| `updating` | Currently running an update |
| `running` | Services are up-to-date and running |
| `pull repo failed` | Could not clone or pull the repository |
| `verification failed` | Commit signature check failed |
| `docker build failed` | `docker compose build` failed |
| `docker compose failed` | `docker compose up` failed |
| `applying system.json failed` | Could not apply system config |

---

## CuOS integration

When `SYSTEM_TYPE=cuos` (set by the CuOS runtime), the IaC container communicates with CuOS via `/var/run/cuos.sock`.

Commands sent to CuOS:

| Command | When |
|---------|------|
| `update:json` | Apply a new `system.json` (includes the full JSON payload) |
| `report_app_ready` | Notify CuOS that IaC is up (shown in CuOS status) |
| `version` | Get CuOS version (forwarded from socket API) |
| `shutdown` | Shutdown host (forwarded from socket API) |
| `reboot` | Reboot host (forwarded from socket API) |
| `rollback` | Roll back to previous OS version (forwarded from socket API) |

In standalone mode (no CuOS socket), `system.json` is written directly to disk.

---

## Config composition (merge-configs.sh)

```
merge-configs.sh /volume/repo/system.json
    │
    ├─► Parse #include directives recursively
    │       Resolve relative paths to absolute paths
    │       Track visited files to prevent circular includes
    │       Build ordered list: includes first, root last
    │
    └─► jq reduce: merge all files left-to-right
            Later files override earlier ones
            Root system.json wins over all includes
```

The `#include` key is removed from the merged output.

---

## Jitter and fleet behavior

To avoid synchronized update storms across many devices:

- On first startup, each device sleeps a random 0–180 seconds before the first update check.
- On subsequent polls, when the interval exceeds 1200 seconds, a random 0–300 second jitter is subtracted from the configured interval.

This spreads Git pull and Docker pull traffic across a fleet without manual coordination.
