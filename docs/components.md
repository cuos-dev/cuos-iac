# Components Overview

CuOS IaC is a modular system. The core IaC container is the only required piece; everything else is optional and added based on your needs.

---

## Component map

```
┌─────────────────────────────────────────────────────────┐
│                    Fleet Management                      │
│                                                         │
│  ┌──────────────────┐         ┌──────────────────────┐  │
│  │   Fleet Server   │◄────────│    Fleet Agent       │  │
│  │  (central, one)  │ WebSocket│  (per device)        │  │
│  └──────────────────┘         └──────────────────────┘  │
│         browser/API                    │                 │
└─────────────────────────────────────────────────────────┘
                                         │ socket
┌────────────────────────────────────────▼────────────────┐
│                  Per-Device Stack                        │
│                                                         │
│  ┌──────────────────┐         ┌──────────────────────┐  │
│  │   CuOS IaC       │         │    WebUI             │  │
│  │  (required)      │◄────────│  (optional)          │  │
│  └──────────────────┘  socket └──────────────────────┘  │
│           │                                             │
│           │ docker-compose.yml                          │
│           ▼                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │          Your services (nginx, app, db, …)       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  ┌──────────────────┐                                   │
│  │  Dev Container   │  SSH (port 3522)                  │
│  │  (optional)      │◄── admin terminal access          │
│  └──────────────────┘                                   │
└─────────────────────────────────────────────────────────┘
```

---

## Components

### CuOS IaC — core

**Image:** `ghcr.io/cuos-dev/cuos-iac`  
**Source:** `iac/`  
**Docs:** [Architecture](architecture.md) · [Configuration](configuration.md) · [API Reference](api.md)

The main engine. Polls a Git repository and keeps the device in sync:

- Clones and polls a Git repository
- Decrypts `.enc` files using a passphrase from `system.json`
- Verifies commit signatures (optional)
- Merges and applies `system.json` to the host
- Starts and updates services via `docker compose`
- Verifies image digests (optional)
- Exposes a Unix socket API at `/socket/cuos-iac.sock`

**Required on every device. All other components are optional.**

---

### WebUI — per-device dashboard

**Image:** `ghcr.io/cuos-dev/cuos-iac-webui`  
**Source:** `webui/`  
**Default port:** `8030`

A lightweight web dashboard for a single device:

- Shows current IaC state, last update time, next scheduled poll
- Trigger an immediate update manually
- Live `docker ps` table
- System stats: CPU, RAM, disk, uptime
- System actions: reboot, shutdown, rollback
- System logs

Add to `docker-compose.yml`:

```yaml
services:
  cuos-iac-webui:
    image: ghcr.io/cuos-dev/cuos-iac-webui:latest
    volumes:
      - /var/run/cuos.sock:/var/run/cuos.sock
      - /system.json:/system.json:ro
    ports:
      - "8030:3000"
    restart: always
```

---

### Fleet Agent — device-side fleet connector

**Image:** `ghcr.io/cuos-dev/cuos-iac-fleet-agent`  
**Source:** `fleet-agent/`  
**Docs:** [Fleet Agent](fleet-agent.md)

Connects a device to the central fleet server:

- Registers the device with a persistent UUID
- Reports system metrics (CPU, RAM, disk, IaC state) every 60 seconds
- Sends heartbeats every 30 seconds
- Receives and executes `update_trigger` commands from the fleet server
- Reconnects automatically on disconnect

Configured via `system.json`:

```json
{
  "fleet_server_url": "ws://fleet.internal:8085",
  "fleet_secret": "your-secret",
  "fleet_tags": ["production", "site-a"]
}
```

Add to `docker-compose.yml`:

```yaml
services:
  cuos-fleet-agent:
    image: ghcr.io/cuos-dev/cuos-iac-fleet-agent:latest
    restart: unless-stopped
    volumes:
      - /system.json:/system.json:ro
      - iac-socket:/socket
      - fleet-agent-data:/data
```

---

### Fleet Server — central management plane

**Image:** `ghcr.io/cuos-dev/cuos-iac-fleet-server`  
**Source:** `fleet-server/`  
**Docs:** [Fleet Server](fleet-server.md)  
**Default port:** `8085`

One instance for your entire fleet:

- Receives connections from fleet agents via WebSocket
- Stores device state and metrics in `/data/clients.json`
- Provides a web dashboard (`/ui`) showing all devices
- REST API for automation: list devices, trigger updates, get direct links
- Triggers immediate updates on individual devices

Deploy once, centrally:

```bash
docker run -d \
  -p 8085:8085 \
  -v fleet-data:/data \
  -e FLEET_SECRET=your-secret \
  -e FLEET_ADMIN_PASS=your-password \
  ghcr.io/cuos-dev/cuos-iac-fleet-server:latest
```

---

### Dev Container — SSH access

**Image:** `ghcr.io/cuos-dev/cuos-iac-dev-container`  
**Source:** `dev-container/`  
**Default port:** `3522` (SSH)

An SSH-accessible container for direct device access:

- Full shell access to the device environment
- Access to Docker, data volumes, and devices
- Authorized via SSH keys in `system.json`

```json
{
  "dev-keys": ["ssh-ed25519 AAAAC3... user@laptop"]
}
```

```bash
ssh -p 3522 root@<device-ip>
```

---

## Choosing your setup

### Minimal — single device, no extras

Just the IaC container. Manages itself from Git automatically.

```
✓ CuOS IaC
✗ WebUI
✗ Fleet Agent
✗ Fleet Server
✗ Dev Container
```

### Recommended — single device

Add the WebUI for visibility and manual control.

```
✓ CuOS IaC
✓ WebUI
✗ Fleet Agent
✗ Fleet Server
✗ Dev Container  (add when debugging is needed)
```

### Fleet — multiple devices

Add fleet agent on each device, fleet server on one central host.

```
[Each device]          [Central host]
✓ CuOS IaC            ✓ Fleet Server
✓ WebUI
✓ Fleet Agent ─────►
✗ Dev Container
```

---

## Port reference

| Port | Component | Purpose |
|------|-----------|---------|
| `8030` | WebUI | Per-device web dashboard |
| `8085` | Fleet Server | Agent WebSocket + admin dashboard + REST API |
| `3522` | Dev Container | SSH access |

---

## Socket reference

| Socket path | Used by |
|-------------|---------|
| `/socket/cuos-iac.sock` | IaC API — used by Fleet Agent, WebUI, and external tools |
| `/var/run/cuos.sock` | CuOS system socket — used by IaC to apply config and send system commands |
