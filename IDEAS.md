# CuOS IaC — Ideas & Improvement Backlog

This document collects ideas and proposed improvements discussed during design sessions.
It is structured so that each section can be handed to an implementing agent independently.

**Ground rules that apply to all work:**
- Git repository remains the single source of truth for all configuration
- Fleet server stays read-only / monitoring-only; no config modification
- All new components are optional and additive — existing setups keep working
- Frontend framework: **Preact** (~3 KB) across all three frontend surfaces, with `@preact/signals` for reactivity and Preact Router for navigation. No React, Angular, Vue, Next.js, or SvelteKit.
- All new services ship as Docker containers with a minimal Alpine-based image

---

## 1. Per-device WebUI — rewrite

**Current problems:**
- 30-second `<meta refresh>` causes the page to jump to the top on every reload
- No real-time feedback during updates
- Messy layout, inconsistent visual design
- No way to interact with individual containers (restart, recreate, etc.)

### 1.1 Real-time state via WebSocket

Replace the meta-refresh polling with a persistent WebSocket connection from the browser to the WebUI server. The WebUI server subscribes to the IaC socket (`/socket/cuos-iac.sock`) and pushes state changes to connected browsers immediately.

- IaC `state` endpoint is polled server-side every 2–3 seconds and pushed to clients on change
- No full-page reload; only affected DOM elements update
- Visual indicator when connection is lost / reconnecting

### 1.2 Live log streaming

Stream `journalctl` output directly to the browser over WebSocket.

- WebUI backend spawns `journalctl -f -n 100 --output=json` (or plain text)
- Output is streamed line-by-line to connected browser clients
- UI shows a scrollable log panel with auto-scroll toggle (pause on manual scroll, resume on click)
- Optional filter by container name / unit
- No external dependency required; available on any systemd host

Optionally, if **VictoriaLogs** is detected (see section 5), the log panel can query historical logs with a time range picker.

### 1.3 Container management

Add a "Containers" tab or section showing all running/stopped containers (equivalent to `docker ps -a`).

Per-container actions:
- **Restart** — `docker restart <id>`
- **Recreate** — `docker compose up -d --force-recreate <service>`
- **Stop / Start** — `docker stop` / `docker start`
- **Pull latest** — pull image and recreate (only for non-digest-pinned containers)
- **View logs** — open log stream filtered to this container

All actions go through the IaC socket API or a new Docker management endpoint. The WebUI never calls Docker directly; the IaC container (which already has Docker socket access) acts as the proxy.

> **IaC backend change needed:** Add `docker:restart`, `docker:recreate`, `docker:stop`, `docker:start` commands to `/api/trigger`.

### 1.4 Update progress visualization

During an active IaC update, show a step-by-step progress view instead of a generic "updating" state:

```
✓ Pulling repository
✓ Verifying commit signature
✓ Decrypting secrets
→ Applying system.json  (in progress)
  Building images
  Starting services
```

The IaC `entrypoint.sh` should emit structured progress events (JSON lines to stderr or a new named pipe) that the WebUI server reads and pushes to the browser.

### 1.5 Visual design

- Clean, minimal design; single-page layout with clear sections
- Mobile-responsive (useful for checking a device from a phone on-site)
- System summary card at the top: hostname, IaC state, last update, next poll countdown
- Consistent status badges with color coding (running = green, error = red, updating = yellow)

---

## 2. Fleet Server WebUI — rewrite

**Current problems:**
- Server-rendered Handlebars with 30s meta refresh
- Very basic design, poor information density
- No historical metrics
- No device drill-down
- No bulk operations

### 2.1 Real-time device table

Replace meta refresh with WebSocket push. The fleet server already maintains live WebSocket connections with all agents — those events should be forwarded to connected browser clients in real time.

- Device status changes (online/offline/updating/error) appear instantly
- Metrics columns (CPU, RAM, disk) update live as agents send new data
- Visual pulse / last-seen indicator per device

### 2.2 Device detail view

Click a device to open a detail panel / page:

- Full metrics breakdown (all fields the agent reports)
- Historical metrics charts if VictoriaMetrics is configured (see section 5)
- IaC state history (last N updates, commit hashes, timestamps)
- Log viewer if VictoriaLogs is configured
- Direct link to per-device WebUI (port 8030) — "Open device UI" button
- Manual update trigger button

### 2.3 Filtering and bulk operations

- Filter device table by tag, status, or free-text search on hostname
- Select multiple devices (checkbox) → bulk "Trigger update" action
- Tag-based bulk update: "Update all devices tagged `production`"

### 2.4 Historical metrics (optional — requires VictoriaMetrics)

If a VictoriaMetrics endpoint is configured in the fleet server environment, the device detail view shows time-series charts for CPU, RAM, and disk over the last 1h / 24h / 7d.

If VictoriaMetrics is not configured, only live/last-known values are shown — no degraded state, just reduced functionality.

### 2.5 Log aggregation (optional — requires VictoriaLogs)

If VictoriaLogs is configured and an agent is set up to forward logs (see section 4.2), the device detail view includes a log search panel.

- Time range picker
- Free-text search
- Filter by severity
- Off by default; only appears if agent is configured to send logs

### 2.6 Visual design

- Same design language as the per-device WebUI rewrite (shared CSS variables / design tokens even if separate repos)
- Card-based device grid as an alternative to the table view
- Status summary at the top: X online, Y offline, Z updating
- Responsive layout

---

## 3. Fleet Server — backend improvements

### 3.1 Replace clients.json with SQLite

The current flat JSON file has no history. Replace it with a SQLite database (single file, no server required, well-supported in Node.js via `better-sqlite3`).

Schema additions over current state:
- `devices` table — current device state (replaces clients.json)
- `metrics_history` table — rolling N-day metrics snapshots (configurable retention, default 7 days)
- `update_events` table — record of every update attempt: device, timestamp, commit hash, success/failure, error message

This enables historical charts and audit log without any external dependency.

### 3.2 Webhook notifications

Add outbound webhook support for fleet events:
- Device comes online / goes offline
- Update succeeds / fails
- Device in error state for > N minutes

Configuration via environment variable:
```
FLEET_WEBHOOK_URL=https://hooks.example.com/...
FLEET_WEBHOOK_EVENTS=update_failed,device_offline
```

Payload is a JSON object with event type, device info, and timestamp.

### 3.3 API key authentication

Add API key support as an alternative to HTTP Basic Auth for automation use cases.

- Keys generated via a setup endpoint (or env var `FLEET_API_KEYS=key1,key2`)
- Passed as `Authorization: Bearer <key>` header
- Basic Auth remains supported for browser access
- Keys can be scoped: `read` (metrics/state only) or `write` (trigger updates)

---

## 4. Fleet Agent — improvements

### 4.1 VictoriaMetrics metrics push

If `victoria_metrics_url` is set in `system.json`, the agent pushes metrics in Prometheus remote write format to that endpoint in addition to (or instead of) sending them to the fleet server.

```json
{
  "victoria_metrics_url": "http://victoriametrics:8428/api/v1/import/prometheus"
}
```

Metrics are labeled with `hostname`, `uuid`, and all `fleet_tags`. This enables Grafana or the fleet server UI to query per-device historical data.

### 4.2 VictoriaLogs log forwarding (optional)

If `victoria_logs_url` is set in `system.json`, the agent optionally forwards selected log streams to VictoriaLogs.

```json
{
  "victoria_logs_url": "http://victorialogs:9428/insert/jsonline",
  "fleet_log_units": ["cuos-iac", "docker"]
}
```

- `fleet_log_units` controls which systemd units / container names to forward
- Logs are forwarded as JSON lines with metadata labels
- If not configured, no logs are forwarded — zero overhead

### 4.3 Configurable metrics interval

Expose `metrics_interval_sec` in `system.json` (currently hardcoded to 60s):

```json
{
  "metrics_interval_sec": 30
}
```

---

## 5. Observability Stack — catalog apps

VictoriaMetrics and VictoriaLogs should be available as catalog apps (see section 7) so users can add them to their `docker-compose.yml` with one click from the config webapp.

Each catalog app provides:
- `docker-compose.yml` — the service definition
- A short description of what it enables in the CuOS IaC ecosystem
- Required params (port, retention period, etc.)

When the config webapp detects these apps are included in a system's compose file, it can show configuration hints for enabling metrics/log forwarding in the fleet agent.

---

## 6. Config Webapp — new component

A self-hosted web application for creating and managing CuOS IaC repositories. It is entirely a "design time" tool — it reads and writes Git repos, and has no runtime connection to the fleet server or to devices.

**Deployment:** standalone Docker container, typically run on a developer's machine or an internal server.

```bash
docker run -d \
  --name cuos-config \
  -p 8090:3000 \
  -v cuos-config-data:/data \
  ghcr.io/cuos-dev/cuos-iac-config:latest
```

### 6.1 Git provider integration

On first run, the user connects one or more Git providers:
- GitHub (via Personal Access Token or OAuth app)
- GitLab (via PAT)
- Gitea / Forgejo (via PAT + base URL)
- Generic Git over SSH

The webapp clones repos locally (to its data volume) and pushes changes back via the configured credentials.

### 6.2 Repo and system discovery

The webapp scans connected repos for `system.json` files and presents each as a "system". A repo with multiple `system.json` files (one per subdirectory) is shown as a group of systems under that repo.

- Sidebar: repos → systems within each repo
- Understands `iac_repo_subdir` — knows which subdirectory each system maps to
- Resolves `#include` chains and shows the effective merged config for any system

### 6.3 System.json editor

Form-based editor for all known `system.json` keys, with:
- Labeled fields with descriptions and validation (e.g. valid URL, valid integer)
- Toggle to "raw JSON" mode for advanced users
- Diff preview before committing — shows exactly what will change
- Commit message auto-generated from changes ("Update iac_poll_interval to 3600")

Unknown keys (custom or future keys) are shown in a passthrough section and preserved as-is.

### 6.4 Docker Compose editor

Visual editor for `docker-compose.yml`:
- Service list with per-service property forms (image, ports, volumes, env vars, restart policy)
- Toggle to raw YAML
- "Add service from catalog" button (opens catalog browser, see 6.6)
- Handles `include:` directives — shows included files as read-only referenced sections
- Validates compose file before committing

### 6.5 Secrets manager

Manages `.enc` files within a system's directory:

- Lists all secrets (filename only, never shows decrypted value after initial entry)
- "Add secret" flow:
  1. Enter filename (e.g. `secrets.json`)
  2. Paste plaintext content
  3. Webapp encrypts using the system's `system_file_password` (AES-256-CBC, PBKDF2, 200k iterations — same as `config-decrypt.sh`)
  4. Commits `secrets.json.enc` to the repo, plaintext never written to disk
- "Rotate secret" — re-encrypt with new content, same key
- `system_file_password` itself is stored in the webapp's local encrypted store (not in the repo), associated with the system by its repo path + subdirectory

### 6.6 Catalog browser

Browse connected catalog repos and add apps to a system:

- Grid/list of available apps with name, description, and tags
- Preview shows the app's `docker-compose.yml` template and required parameters
- "Add to system" flow:
  1. Fill in required params (ports, domain, passwords)
  2. Any param marked as secret is automatically encrypted and stored as `.enc`
  3. The app's compose snippet is added to the system's `docker-compose.yml` (or as a new include file)
  4. All changes committed together in one commit

### 6.7 Catalog management

- "Connect catalog" — enter a Git repo URL; the webapp runs `git submodule add` in the system repo under `catalogs/<name>/`
- "Update catalog" — pulls the latest version of a connected catalog submodule
- "Disconnect catalog" — removes the submodule
- Multiple catalogs can be connected simultaneously (official + private)

### 6.8 Onboarding wizard — new system

Step-by-step flow for adding a new device/system to a repo:

1. Choose repo (or create new one)
2. Enter system name / hostname (becomes the subdirectory name)
3. Fill in key config fields: repo URL for the device, branch, poll interval
4. Choose initial services from the catalog (optional)
5. Add SSH keys for dev container access (optional)
6. Preview generated files
7. Commit + push
8. Show the bootstrap `system.json` snippet to paste onto the device

### 6.9 Commit and push

All changes in the webapp are staged locally and committed + pushed when the user clicks "Save & Deploy":

- Commit message is auto-generated but editable
- Diff view before confirming
- Option to **disable auto-push** for advanced users who want to review in their Git client before pushing (changes are committed locally, push is manual)
- Push status shown after commit

### 6.10 Webapp signing key

On first startup, the webapp generates an SSH keypair stored in its data volume:

- Private key: `/data/signing_key` (never exposed via UI)
- Public key: shown in the webapp's settings page with copy button and instructions to add to `iac_repo_signing_keys`

All commits made by the webapp are signed with this key. The key identity is "cuos-config-webapp". It can be revoked by removing it from `iac_repo_signing_keys`.

---

## 7. Application Catalog — structure and tiers

The catalog is a Git repository with a defined directory structure. The config webapp reads it as a git submodule.

### 7.1 Directory structure

```
catalog-repo/
├── README.md
└── apps/
    ├── nginx/
    │   ├── manifest.json
    │   ├── docker-compose.yml
    │   ├── config/
    │   │   └── nginx.conf
    │   └── README.md
    ├── victoriametrics/
    │   ├── manifest.json
    │   └── docker-compose.yml
    └── nextcloud/
        ├── manifest.json
        ├── docker-compose.yml
        └── config/
```

### 7.2 App manifest format

`manifest.json` describes the app and its required inputs:

```json
{
  "name": "Nextcloud",
  "description": "Self-hosted file sync and share",
  "tags": ["storage", "productivity"],
  "version": "1.0.0",
  "params": [
    {
      "key": "port",
      "label": "HTTP Port",
      "type": "integer",
      "default": 8080
    },
    {
      "key": "admin_password",
      "label": "Admin Password",
      "type": "string",
      "secret": true
    }
  ],
  "ports": [8080],
  "notes": "After first start, complete setup at http://<device>:<port>"
}
```

Params with `"secret": true` are automatically handled by the secrets manager — the value is encrypted and stored as a `.enc` file; only the reference is written into `docker-compose.yml`.

### 7.3 Catalog tiers

| Tier | Repo | Trust | Distribution |
|------|------|-------|--------------|
| **Official** | `cuos-dev/cuos-catalog` | Maintained by cuos-dev | Pre-connected in new repos |
| **Community** | `cuos-dev/cuos-catalog-community` | PR-reviewed, community-contributed | Optional, connect via webapp |
| **Private** | Any Git repo | Self-managed | Connect via webapp with any Git URL |

---

## 8. IaC Core — improvements

### 8.1 Structured progress events

During updates, `entrypoint.sh` should emit structured JSON events to a well-known location (e.g., appended to `/volume/progress.json` or a named pipe) so the per-device WebUI can stream real-time update progress.

Event format:
```json
{"step": "clone_repo", "status": "done", "ts": "2024-01-15T10:00:01Z"}
{"step": "verify_commit", "status": "done", "ts": "2024-01-15T10:00:02Z"}
{"step": "decrypt_files", "status": "in_progress", "ts": "2024-01-15T10:00:03Z"}
```

Steps: `clone_repo`, `verify_commit`, `decrypt_files`, `apply_system_json`, `docker_build`, `docker_compose`

### 8.2 Docker management API

Add commands to `/api/trigger` to enable per-container actions from the per-device WebUI:

| Command | Action |
|---------|--------|
| `docker:ps` | Return `docker ps -a` as JSON (already exists as `ps`) |
| `docker:restart <name>` | `docker restart <container>` |
| `docker:recreate <service>` | `docker compose up -d --force-recreate <service>` |
| `docker:stop <name>` | `docker stop <container>` |
| `docker:start <name>` | `docker start <container>` |
| `docker:logs <name>` | Stream last 200 lines + follow for `<container>` |

All commands validate that the container/service name is part of the managed compose project before executing.

### 8.3 Config dry-run

Add a `dry-run` command to `/api/trigger` that performs all update steps (clone, decrypt, merge config) but stops before applying changes — and instead returns a diff of what would change in `system.json` and `docker-compose.yml`.

Useful for the config webapp's "preview" feature and for manual verification before triggering a real update.

---

## 9. Cross-cutting concerns

### 9.1 Shared design system

Both WebUIs (per-device and fleet server) should share:
- CSS custom properties / design tokens (colors, spacing, typography)
- Core UI components if the same framework is used for both
- Favicon and brand assets

This ensures visual consistency without tight coupling between the two projects.

### 9.2 Framework recommendation

**Decision: Preact across all three frontend surfaces.**

[Preact](https://preactjs.com/) (~3 KB runtime) is used for the per-device WebUI, fleet server WebUI, and config webapp.

Rationale:
- Smallest React-compatible runtime available — negligible overhead
- `@preact/signals` provides fine-grained reactivity ideal for live-updating metrics and log streams without full component re-renders
- React ecosystem compatibility (`preact/compat`) gives access to libraries if needed
- One framework across all three surfaces: single mental model, consistent build setup, contributors can move between codebases without context switching
- Preact Router (~1.5 KB) handles the multi-page structure of the config webapp

**Avoid:** React, Vue, Angular, SvelteKit — unnecessary bundle size or complexity for these use cases. SvelteKit in particular adds SSR/routing infrastructure that the existing Express backends already handle.

### 9.3 Consistent API patterns across WebUIs

Both WebUIs expose a small HTTP + WebSocket API from their server to the browser. Align on:
- REST for one-shot queries (state, ps, metrics)
- WebSocket for streaming (logs, live state updates, update progress)
- JSON throughout
- Same error envelope format: `{"error": "message", "code": "snake_case_code"}`
