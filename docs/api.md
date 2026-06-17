# API Reference

CuOS IaC exposes a Unix socket API at `/socket/cuos-iac.sock`. Any container with access to this socket (or any process on the host if the socket is bind-mounted) can send commands.

---

## Connecting to the socket

**Using socat:**

```bash
echo '{"app_command": "state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

**From another container:**

Mount the socket volume and use socat:

```yaml
services:
  my-service:
    image: ...
    volumes:
      - iac-socket:/socket
```

```bash
echo '{"app_command": "update"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

**Direct command syntax** (when running inside the IaC container):

```bash
/api/trigger update
```

---

## Commands

### `update`

Trigger an immediate update check without waiting for the next poll interval.

```bash
echo '{"app_command": "update"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

This works by sending `SIGKILL` to the currently sleeping poll timer, causing `check_update()` to run immediately. The update runs asynchronously — use [`state`](#state) to monitor progress.

---

### `state`

Return the current IaC state from `/volume/state.json`.

```bash
echo '{"app_command": "state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

Example response:

```json
{
  "last_iac_start": "2024-01-15T10:00:00Z",
  "iac_state": "running",
  "iac_commit": "a1b2c3d4e5f6...",
  "last_iac_update_check": "2024-01-15T16:00:00Z",
  "last_iac_update": "2024-01-15T10:01:30Z"
}
```

See [Architecture — State file](architecture.md#state-file) for field descriptions.

---

### `ps`

Return running Docker containers as a JSON array.

```bash
echo '{"app_command": "ps"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

Example response:

```json
[
  {
    "ID": "abc123",
    "Image": "nginx:1.25.3",
    "Command": "/docker-entrypoint.sh nginx",
    "CreatedAt": "2024-01-15 10:01:30 +0000 UTC",
    "RunningFor": "6 hours ago",
    "Ports": "0.0.0.0:80->80/tcp",
    "State": "running",
    "Status": "Up 6 hours",
    "Names": "iac-my-app-1"
  }
]
```

Equivalent to `docker ps -a --format '{{json .}}'`.

---

### `config`

Apply a signed configuration update. The payload must be a compact JWS token (base64url-encoded JSON + SSH signature).

```bash
echo "{\"app_command\": \"config\", \"config\": \"${TOKEN}\"}" \
  | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

**Requirements:**

- The token must be signed by a key listed in `iac_repo_signing_keys`.
- The JSON payload must include an `iat` (issued-at) Unix timestamp.
- The token must be used within **15 minutes** of the `iat` value.

**Token format:**

```
<base64url(json-payload)>.<base64url(ssh-signature)>
```

**Example payload:**

```json
{
  "iat": 1705315200,
  "name": "alice",
  "config": {
    "iac_poll_interval": 900
  }
}
```

**Constructing a token** (see [Security Guide](security.md#signed-config-updates-via-api) for a full example):

```bash
IAT=$(date +%s)
PAYLOAD=$(jq -n --argjson iat "$IAT" --arg name "alice" \
  '{"iat": $iat, "name": $name, "config": {"iac_poll_interval": 900}}')
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | base64 -w0 | tr '+/' '-_' | tr -d '=')
SIG=$(printf '%s' "$PAYLOAD" | ssh-keygen -Y sign -f ~/.ssh/deploy_sign -n file /dev/stdin \
  | base64 -w0 | tr '+/' '-_' | tr -d '=')
TOKEN="${PAYLOAD_B64}.${SIG}"
```

---

### `cuos:version`

Return the CuOS system version. Forwarded to the CuOS socket.

```bash
echo '{"app_command": "cuos:version"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

Returns nothing if the CuOS socket is not available.

---

### `cuos:version:json`

Return the CuOS system version as JSON.

```bash
echo '{"app_command": "cuos:version:json"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:log`

Return recent CuOS system logs.

```bash
echo '{"app_command": "cuos:log"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:state`

Return the CuOS system state.

```bash
echo '{"app_command": "cuos:state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:resources`

Return system resource usage (CPU, memory, disk).

```bash
echo '{"app_command": "cuos:resources"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:shutdown`

Shut down the host system. Forwarded to CuOS.

```bash
echo '{"app_command": "cuos:shutdown"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:reboot`

Reboot the host system. Forwarded to CuOS.

```bash
echo '{"app_command": "cuos:reboot"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### `cuos:rollback`

Roll back to the previous OS version. Forwarded to CuOS.

```bash
echo '{"app_command": "cuos:rollback"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

## Lifecycle hooks

These scripts are called by the main `entrypoint.sh` at defined lifecycle points and are not typically called directly via the socket. They are documented here for completeness.

### `/api/pre_update`

Called immediately before an update cycle begins. Kills any sleeping poll timer to unblock the update process.

### `/api/post_update`

Called after an update cycle completes. If `iac_manual_updates` is `true`, releases the infinite sleep to allow the IaC service to return to its wait state.

### `/api/stop`

Stops all Docker Compose services managed by IaC:

```bash
/api/stop
```

Runs `docker compose down --remove-orphans`. Useful for clean shutdown of all services before a maintenance window.

---

## Help

List all available commands:

```bash
echo '{"app_command": "help"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
# or from inside the container:
/api/trigger --help
```
