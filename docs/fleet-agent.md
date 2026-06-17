# Fleet Agent

The fleet agent runs on each CuOS IaC device and connects it to the [fleet server](fleet-server.md). It reports system metrics and state, and executes update commands received from the server.

It is an **optional component** — add it to devices you want visible in the fleet dashboard.

---

## What the agent does

1. Reads configuration from `system.json` on the device.
2. Connects to the fleet server via WebSocket.
3. Registers itself with a persistent UUID and device metadata.
4. Sends a **heartbeat** every 30 seconds to stay marked as online.
5. Sends **metrics** (CPU, RAM, disk, IaC state, etc.) every 60 seconds.
6. Listens for **update_trigger** commands and forwards them to the IaC container via the local socket API.
7. Reconnects automatically if the connection drops (exponential backoff, up to 3 minutes).

---

## Deployment

Add the fleet agent as a service in your IaC repository's `docker-compose.yml`:

```yaml
services:
  cuos-fleet-agent:
    image: ghcr.io/cuos-dev/cuos-iac-fleet-agent:latest
    restart: unless-stopped
    volumes:
      - /system.json:/system.json:ro
      - iac-socket:/socket
      - fleet-agent-data:/data

volumes:
  iac-socket:
    external: true    # shared with the cuos-iac container
  fleet-agent-data:
```

The agent reads `/system.json` for its configuration and communicates with the IaC container via the shared `iac-socket` volume.

---

## Configuration

The agent is configured through `system.json` on the device. All keys are optional except `fleet_server_url`.

### `fleet_server_url`

**Required.** WebSocket URL of the fleet server.

```json
{
  "fleet_server_url": "ws://fleet.example.com:8085"
}
```

Use `wss://` in production environments with TLS termination in front of the fleet server.

### `fleet_secret`

**Type:** `string` | **Default:** `changeme`

Shared secret matching the fleet server's `FLEET_SECRET`. Must be the same on all devices connecting to the same server.

```json
{
  "fleet_secret": "your-strong-secret"
}
```

### `enable_fleet`

**Type:** `boolean` | **Default:** `true`

Set to `false` to disable the fleet agent entirely without removing it from the compose file.

```json
{
  "enable_fleet": false
}
```

### `fleet_tags`

**Type:** `array` of strings | **Default:** `[]`

Arbitrary tags reported to the fleet server for grouping and filtering.

```json
{
  "fleet_tags": ["production", "europe", "line-a"]
}
```

### `fleet_uuid`

**Type:** `string` | **Default:** auto-generated

Persistent device identity. Normally generated automatically on first run and saved to `/data/state_fleet_uuid`. Set this explicitly if you need a predictable UUID (e.g., pre-provisioned fleets).

```json
{
  "fleet_uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

### `heartbeat_interval_sec`

**Type:** `integer` | **Default:** `30`

How often the agent sends a heartbeat to the fleet server (seconds).

```json
{
  "heartbeat_interval_sec": 60
}
```

### Hostname resolution

The agent resolves the device display name in this order:

1. `hostname` in system.json
2. `system_name` in system.json
3. `iac_repo_subdir` in system.json
4. `"unknown"` (fallback)

```json
{
  "hostname": "factory-gw-01"
}
```

---

## Environment variables

These override the corresponding `system.json` keys and are mainly useful for testing.

| Variable | Default | Description |
|----------|---------|-------------|
| `CUOS_SYSTEM_JSON` | `/system.json` | Path to the system config file |
| `FLEET_SERVER_URL` | — | Fleet server URL (overrides `fleet_server_url`) |
| `FLEET_SECRET` | `changeme` | Shared secret (overrides `fleet_secret`) |
| `FLEET_UUID_FILE` | `/data/state_fleet_uuid` | File path for persisting the device UUID |
| `IAC_SOCKET_PATH` | `/socket/cuos-iac.sock` | Unix socket for the local IaC API |

---

## Metrics reported

The agent collects and sends the following data every 60 seconds:

### System state

| Field | Description |
|-------|-------------|
| `version` | CuOS / OS version |
| `state` | System state |
| `start_date` | System start time |
| `last_update_date` | Last OS update time |
| `last_update_check` | Last update check time |
| `partition` | Active partition |
| `update_state` | Current update state |

### Resources

| Field | Description |
|-------|-------------|
| `cpu_usage` | CPU utilization (%) |
| `cpu_cores` | Number of CPU cores |
| `ram_percent` | RAM utilization (%) |
| `mem_used_mb` | Used memory (MB) |
| `mem_total_mb` | Total memory (MB) |
| `disk_percent` | Disk utilization (%) |
| `disk_used_mb` | Used disk space (MB) |
| `disk_total_mb` | Total disk space (MB) |
| `virt_type` | Virtualization type (KVM, LXC, bare metal, …) |
| `default_route_ip` | Default gateway IP |
| `dns_servers` | DNS server list |
| `ntp_servers` | NTP server list |
| `ntp_service_active` | Whether NTP service is running |
| `routes` | Routing table |
| `network` | Network interface info |

### IaC app state

| Field | Description |
|-------|-------------|
| `iac_state` | Current IaC state (`running`, `updating`, etc.) |
| `last_iac_update` | Timestamp of last IaC update |
| `iac_commit` | Git commit hash of applied IaC state |

---

## Reconnection behavior

If the WebSocket connection to the fleet server is lost, the agent reconnects automatically using exponential backoff:

- First retry: 5 seconds
- Subsequent retries: doubles each time, up to a maximum of 3 minutes
- Retries indefinitely until the connection is restored

---

## UUID persistence

Each device gets a random UUID on first run. It is stored at `/data/state_fleet_uuid` (configurable via `FLEET_UUID_FILE`). This UUID is stable across container restarts and is the device's permanent identity in the fleet server.

If the UUID file is lost (e.g., the data volume is deleted), the agent generates a new UUID and the device appears as a new entry in the fleet server.

---

## Hot configuration reload

The agent re-reads `system.json` on each metrics cycle (every 60 seconds). Changes to `fleet_tags`, `hostname`, or other configuration values take effect without restarting the container.

---

## Minimal example — full system.json with fleet enabled

```json
{
  "hostname": "edge-device-01",
  "iac_repo_url": "https://token@github.com/org/iac.git",
  "iac_repo_branch": "main",
  "iac_poll_interval": 3600,

  "fleet_server_url": "ws://fleet.internal:8085",
  "fleet_secret": "your-strong-secret",
  "fleet_tags": ["production", "site-a"]
}
```
