# Configuration Reference

All CuOS IaC settings are read from `/system.json` on the host. When a `system.json` is present in your IaC repository, its values are merged into the host config automatically (see [Config Composition](#config-composition)).

---

## Repository settings

### `iac_repo_url`

**Type:** `string` | **Required**

The Git repository URL to clone and track. Embed credentials directly in the URL for private repositories.

```json
{
  "iac_repo_url": "https://token:ghp_yourtoken@github.com/your-org/your-iac-repo.git"
}
```

> The URL is checked on every poll. If it changes, the repository is re-cloned automatically.

### `iac_repo_branch`

**Type:** `string` | **Default:** repository default branch

The branch to track. If omitted, the repository's default branch is used.

```json
{
  "iac_repo_branch": "production"
}
```

### `iac_repo_subdir`

**Type:** `string` | **Default:** repository root

A subdirectory within the repository to use as the working root. Both `system.json` and `docker-compose.yml` are expected relative to this path.

```json
{
  "iac_repo_subdir": "environments/prod"
}
```

---

## Update behavior

### `iac_poll_interval`

**Type:** `integer` (seconds) | **Default:** `21600` (6 hours)

How often to check for repository updates. A random jitter of up to 300 seconds is applied automatically when the interval exceeds 1200 seconds, to prevent synchronized traffic spikes across a fleet.

```json
{
  "iac_poll_interval": 3600
}
```

Common values:

| Value | Interval |
|-------|----------|
| `900` | 15 minutes |
| `3600` | 1 hour |
| `21600` | 6 hours (default) |
| `86400` | 24 hours |

### `iac_manual_updates`

**Type:** `boolean` | **Default:** `false`

When set to `true`, the IaC container waits indefinitely instead of polling. Updates only happen when triggered explicitly via the [socket API](api.md#update).

```json
{
  "iac_manual_updates": true
}
```

Use this when you want full control over when updates are applied — for example, in production environments with a change approval process.

---

## Security settings

### `system_file_password`

**Type:** `string` | **Default:** none

Passphrase used to decrypt `.enc` files found in the repository. All files matching `*.enc` are decrypted using AES-256-CBC with PBKDF2 key derivation (200,000 iterations).

```json
{
  "system_file_password": "my-secret-passphrase"
}
```

See [Security Guide — Encryption](security.md#file-encryption) for how to create encrypted files.

### `iac_repo_signing_keys`

**Type:** `object` (`{ "name": "ssh-public-key" }`) | **Default:** none

SSH public keys used to verify Git commit signatures. When set, the IaC container rejects any commit that is not signed by one of the listed keys.

```json
{
  "iac_repo_signing_keys": {
    "alice": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
    "bob":   "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
  }
}
```

See [Security Guide — Commit Signing](security.md#commit-signing).

### `os_image_digest`

**Type:** `string` | **Default:** none

Expected SHA-256 digest of the host OS image. When set, the IaC container passes this to CuOS for OS-level update verification.

```json
{
  "os_image_digest": "sha256:abc123..."
}
```

When omitted, CuOS IaC polls for OS updates every ~2 hours as a fallback.

### `initial_image_digest`

**Type:** `string` | **Default:** none

Expected digest of the `ghcr.io/cuos-dev/cuos-iac` image itself. Set this to pin the IaC container version.

```json
{
  "initial_image_digest": "sha256:def456..."
}
```

---

## Network and TLS

### `custom_ca_certs`

**Type:** `object` (`{ "name": "PEM certificate" }`) | **Default:** none

Custom CA certificates to install into the container's trust store. Use this when your Git repository or Docker registry is served by an internal or self-signed CA.

```json
{
  "custom_ca_certs": {
    "my-internal-ca": "-----BEGIN CERTIFICATE-----\nMIID...\n-----END CERTIFICATE-----"
  }
}
```

CA certificates are updated at startup and whenever the `custom_ca_certs` value changes between updates.

---

## CuOS-specific settings

These settings are used by CuOS itself, and are typically written into `system.json` on first boot.

### `initial_image`

**Type:** `string`

The Docker image to run as the IaC container. Set on CuOS hosts to bootstrap IaC.

```json
{
  "initial_image": "ghcr.io/cuos-dev/cuos-iac"
}
```

### `initial_image_version`

**Type:** `string` | **Default:** `latest`

Image tag for `initial_image`.

```json
{
  "initial_image_version": "1.2.3"
}
```

### `hostname`

**Type:** `string`

The hostname shown in the WebUI startup message. If set, the IaC container reports `http://<hostname>:8030/` as the WebUI address on startup.

```json
{
  "hostname": "edge-device-01"
}
```

### `dev-keys`

**Type:** `array` of SSH authorized key strings

SSH public keys granted access to the dev container (port 3522). Supports standard `authorized_keys` format including `environment=` options.

```json
{
  "dev-keys": [
    "ssh-ed25519 AAAAC3... user@workstation",
    "environment=\"GIT_AUTHOR_NAME=Alice\",environment=\"GIT_AUTHOR_EMAIL=alice@example.com\" ssh-rsa AAAA..."
  ]
}
```

---

## Config composition

`system.json` supports an `#include` directive to merge multiple JSON files into one. This is processed by the `merge-configs.sh` script before any values are applied.

### Syntax

```json
{
  "#include": "./secrets.json",
  "hostname": "my-device"
}
```

Or as an array:

```json
{
  "#include": ["./base.json", "./overrides.json"],
  "iac_poll_interval": 3600
}
```

### Merge rules

- Included files are processed recursively (includes within includes are supported).
- Circular includes are detected and skipped.
- Files are merged left-to-right: later files override earlier ones.
- The root `system.json` is merged last, so its values take highest precedence.

### Example structure

```
iac-repo/
├── system.json
├── secrets.json          # decrypted from secrets.json.enc
├── base/
│   └── system.json       # shared base config
└── services/
    └── docker-compose.yml
```

`system.json`:
```json
{
  "#include": ["./base/system.json", "./secrets.json"],
  "hostname": "prod-device-01",
  "iac_poll_interval": 3600
}
```

---

## Environment variables

These environment variables are available inside the IaC container and can override certain behaviors:

| Variable | Description |
|----------|-------------|
| `SYSTEM_CONFIG_PATH` | Path to `system.json` inside the container (default: `/system.json`) |
| `IAC_COMPOSE_PROJECT_NAME` | Docker Compose project name (default: `iac`) |
| `LABEL` | Docker label used to find the IaC container itself (default: `dev.cuos.iac`) |
| `VOLUME_MNT` | Container path for the volume mount (default: `/volume`) |
| `IAC_FILE_PASSPHRASE` | Decryption passphrase — set automatically from `system_file_password` |
| `DOCKER_CONTEXT` | Docker context to use (default: `default`) |

---

## Full example

```json
{
  "hostname": "factory-gw-01",

  "initial_image": "ghcr.io/cuos-dev/cuos-iac",
  "initial_image_version": "latest",
  "initial_image_digest": "sha256:abc123...",

  "iac_repo_url": "https://deploy:ghp_token@github.com/acme/iac.git",
  "iac_repo_branch": "production",
  "iac_repo_subdir": "devices/factory-gw",
  "iac_poll_interval": 3600,
  "iac_manual_updates": false,

  "system_file_password": "super-secret-passphrase",

  "iac_repo_signing_keys": {
    "ci-bot": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
    "alice":  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
  },

  "os_image_digest": "sha256:def456...",

  "custom_ca_certs": {
    "acme-internal-ca": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----"
  },

  "dev-keys": [
    "ssh-ed25519 AAAAC3... alice@laptop"
  ]
}
```
