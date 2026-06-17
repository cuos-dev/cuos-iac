# Fleet Server

The fleet server is a centralized management plane for a fleet of CuOS IaC devices. It collects metrics and status from all connected devices, displays them in a dashboard, and lets you trigger updates remotely.

It is an **optional component** — individual devices work fine without it. Add it when you manage more than a handful of devices and want a single place to monitor and control them.

---

## Architecture overview

```
Fleet Server (one instance)
    │
    ├── WebSocket /ws/<secret>  ◄──── Fleet Agent (each device)
    │       bidirectional JSON
    │
    ├── REST API /api/*         ◄──── Automation / CI
    │       HTTP Basic Auth
    │
    └── WebUI /ui               ◄──── Admin browser
            server-rendered
```

The fleet server stores device state in a JSON file (`/data/clients.json`). It requires no external database.

---

## Deployment

### Docker (recommended)

```bash
docker run -d \
  --name cuos-fleet-server \
  --restart unless-stopped \
  -p 8085:8085 \
  -v fleet-data:/data \
  -e FLEET_SECRET=your-strong-secret \
  -e FLEET_ADMIN_USER=admin \
  -e FLEET_ADMIN_PASS=your-strong-password \
  ghcr.io/cuos-dev/cuos-iac-fleet-server:latest
```

### Docker Compose

```yaml
services:
  cuos-fleet-server:
    image: ghcr.io/cuos-dev/cuos-iac-fleet-server:latest
    restart: unless-stopped
    ports:
      - "8085:8085"
    volumes:
      - fleet-data:/data
    environment:
      FLEET_SECRET: your-strong-secret
      FLEET_ADMIN_USER: admin
      FLEET_ADMIN_PASS: your-strong-password
      TZ: Europe/Berlin

volumes:
  fleet-data:
```

---

## Configuration

All settings are provided as environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `FLEET_SERVER_PORT` | `8085` | HTTP listen port |
| `FLEET_SECRET` | `changeme` | Shared secret for agent WebSocket connections |
| `FLEET_ADMIN_USER` | `admin` | Dashboard and API username |
| `FLEET_ADMIN_PASS` | `admin` | Dashboard and API password |
| `FLEET_DATA_DIR` | `/data` | Directory for persistent state storage |
| `TZ` | `Europe/Berlin` | Timezone for date display |
| `LOCALE` | `de-DE` | Locale for date formatting |

> **Security:** Change `FLEET_SECRET`, `FLEET_ADMIN_USER`, and `FLEET_ADMIN_PASS` before exposing the server to a network. The defaults are intentionally weak placeholders.

---

## Dashboard

Access the web dashboard at `http://<server>:8085/ui`.

Login with `FLEET_ADMIN_USER` / `FLEET_ADMIN_PASS`.

The dashboard shows a table of all known devices with:

| Column | Description |
|--------|-------------|
| Hostname | Device identifier |
| Status | `online` / `offline` / `updating` / `error` |
| IaC State | Last known IaC state from the device |
| CuOS Version | Version string reported by the device |
| Last Update | Timestamp of last successful IaC update |
| CPU / RAM / Disk | Live resource utilization percentages |
| Last Seen | Timestamp of last heartbeat |
| Actions | **Update** (trigger immediate update), **Visit** (open device WebUI) |

The dashboard auto-refreshes every 30 seconds.

---

## REST API

All API endpoints require HTTP Basic Auth.

### List all clients

```
GET /api/clients
```

Returns a JSON array of all known client objects (online and offline).

```bash
curl -u admin:password http://fleet-server:8085/api/clients | jq .
```

Example response:

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "hostname": "edge-device-01",
    "status": "online",
    "cuos_version": "1.2.3",
    "tags": ["production", "europe"],
    "repo_url": "https://github.com/org/iac.git",
    "repo_branch": "main",
    "connected_at": "2024-01-15T10:00:00.000Z",
    "last_seen": "2024-01-15T16:30:00.000Z",
    "last_update": "2024-01-15T10:01:30.000Z",
    "metrics": {
      "state": { "version": "1.2.3", "state": "running" },
      "resources": {
        "cpu_usage": 12.5,
        "ram_percent": 45.2,
        "disk_percent": 33.8
      },
      "app_state": { "iac_state": "running", "iac_commit": "abc123" },
      "collected_at": "2024-01-15T16:30:00.000Z"
    }
  }
]
```

### Trigger update for a device

```
POST /api/clients/:id/update
```

Sends an `update_trigger` message to the device with the given UUID. The device must be online.

```bash
curl -u admin:password -X POST \
  http://fleet-server:8085/api/clients/550e8400-e29b-41d4-a716-446655440000/update
```

Response:

```json
{ "status": "triggered" }
```

### Get device WebUI link

```
GET /api/clients/:id/direct
```

Returns the direct URL to the device's local WebUI (port 8030), using the device's reported hostname.

```bash
curl -u admin:password \
  http://fleet-server:8085/api/clients/550e8400-e29b-41d4-a716-446655440000/direct
```

Response:

```json
{ "url": "http://edge-device-01:8030" }
```

---

## WebSocket protocol

Agents connect via WebSocket at `/ws/<FLEET_SECRET>`. The protocol uses JSON messages.

### Agent → Server messages

#### `client_hello`

Sent immediately on connection. Registers the device.

```json
{
  "type": "client_hello",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "hostname": "edge-device-01",
  "cuos_version": "1.2.3",
  "tags": ["production"],
  "repo_url": "https://github.com/org/iac.git",
  "repo_branch": "main",
  "protocol_version": 1
}
```

#### `heartbeat`

Sent every 30 seconds (configurable). Keeps the device marked as `online`.

```json
{
  "type": "heartbeat",
  "uuid": "550e8400-e29b-41d4-a716-446655440000"
}
```

#### `metrics`

Sent every 60 seconds. Contains system state and resource data.

```json
{
  "type": "metrics",
  "uuid": "550e8400-e29b-41d4-a716-446655440000",
  "state": {
    "version": "1.2.3",
    "state": "running",
    "start_date": "2024-01-15T10:00:00Z",
    "last_update_date": "2024-01-15T10:01:30Z"
  },
  "resources": {
    "cpu_usage": 12.5,
    "cpu_cores": 4,
    "ram_percent": 45.2,
    "mem_used_mb": 924,
    "mem_total_mb": 2048,
    "disk_percent": 33.8,
    "disk_used_mb": 8192,
    "disk_total_mb": 24240
  },
  "app_state": {
    "iac_state": "running",
    "iac_commit": "abc123def456"
  }
}
```

#### `update_status`

Sent when an update starts and when it completes.

```json
{ "type": "update_status", "uuid": "...", "phase": "start" }
{ "type": "update_status", "uuid": "...", "phase": "finished", "success": true }
{ "type": "update_status", "uuid": "...", "phase": "finished", "success": false, "error": "docker compose failed" }
```

### Server → Agent messages

#### `server_welcome`

Sent immediately on connection to acknowledge registration.

```json
{ "type": "server_welcome", "server_time": "2024-01-15T10:00:00.000Z" }
```

#### `update_trigger`

Sent when an admin triggers an update via the dashboard or REST API.

```json
{ "type": "update_trigger", "reason": "manual" }
```

---

## Persistent storage

The server writes all client state to `$FLEET_DATA_DIR/clients.json` (default: `/data/clients.json`). The file is updated atomically (written to a temp file, then renamed) on every state change.

Back up this file to preserve device history across server restarts.

---

## Tagging devices

Devices can report arbitrary string tags via the `fleet_tags` key in `system.json`. Use tags to group devices by environment, region, role, or any other dimension. Tags are displayed in the dashboard and included in the `/api/clients` response.

```json
{
  "fleet_tags": ["production", "europe", "factory-line-2"]
}
```
