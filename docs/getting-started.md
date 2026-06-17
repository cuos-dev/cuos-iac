# Getting Started

This guide walks you through setting up CuOS IaC from scratch — from creating your IaC repository to having services running and auto-updating.

---

## Prerequisites

- A host running [CuOS](https://github.com/cuos-dev/cuos), **or** any Linux host with Docker installed (see [Standalone Usage](standalone.md))
- A Git repository you control (GitHub, GitLab, Gitea, or self-hosted)
- Docker registry access (public or with credentials in the repo URL)

---

## Step 1: Create your IaC repository

Create a new Git repository. At minimum it needs two files:

```
your-iac-repo/
├── system.json
└── docker-compose.yml
```

### `system.json`

This is the host configuration file. It also drives the IaC service itself:

```json
{
  "iac_repo_url": "https://token:ghp_yourtoken@github.com/your-org/your-iac-repo.git",
  "iac_repo_branch": "main"
}
```

> **Note:** Embed credentials directly in the URL for private repositories. Use a read-only access token with minimal permissions.

### `docker-compose.yml`

Define the services you want to run on the host:

```yaml
services:
  my-app:
    image: nginx:latest
    ports:
      - "80:80"
    restart: always
```

Commit and push both files.

---

## Step 2: Bootstrap CuOS IaC

### On a CuOS system

Add the following to your CuOS `system.json` (the one on the host, not in the repo):

```json
{
  "initial_image": "ghcr.io/cuos-dev/cuos-iac",
  "initial_image_version": "latest",
  "iac_repo_url": "https://token:ghp_yourtoken@github.com/your-org/your-iac-repo.git"
}
```

CuOS will pull the IaC container image and start it automatically.

### On a standalone host

Run the IaC container directly with Docker:

```bash
docker run -d \
  --name cuos-iac \
  --memory 512MB \
  --read-only \
  --tmpfs /etc/ssl/certs:rw,noexec,nosuid,size=16m \
  --tmpfs /tmp:rw,size=64m \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /root/.docker/config.json:/root/.docker/config.json:ro \
  --volume iac-socket:/socket \
  --volume iac-volume:/volume \
  --volume /path/to/your/system.json:/system.json:ro \
  ghcr.io/cuos-dev/cuos-iac:latest
```

See [Standalone Usage](standalone.md) for more details.

---

## Step 3: Verify it's running

Check the IaC state via the socket API:

```bash
echo '{"app_command":"state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

Expected output when healthy:

```json
{
  "last_iac_start": "2024-01-15T10:00:00Z",
  "iac_state": "running",
  "iac_commit": "abc1234...",
  "last_iac_update": "2024-01-15T10:01:30Z"
}
```

Or use `docker ps` to confirm your services came up:

```bash
docker ps
```

---

## Step 4: Push a change

Edit `docker-compose.yml` in your repository and push. Either wait for the next poll interval (default 6 hours), or trigger an immediate update:

```bash
echo '{"app_command":"update"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

The IaC container will pull the latest commit and apply the changes.

---

## Optional components

### WebUI

Add a web interface to monitor status, trigger updates, and manage the system:

```yaml
services:
  cuos-iac-webui:
    image: "ghcr.io/cuos-dev/cuos-iac-webui:latest"
    volumes:
      - /var/run/cuos.sock:/var/run/cuos.sock
      - /system.json:/system.json:ro
    ports:
      - "8030:3000"
    restart: always
```

Access it at `http://<host-ip>:8030/`.

### Dev Container

Add an SSH-accessible debug container for direct system access:

```yaml
services:
  cuos-dev-container:
    image: "ghcr.io/cuos-dev/cuos-iac-dev-container:latest"
    container_name: cuos-dev-container
    network_mode: host
    pid: host
    privileged: true
    volumes:
      - /root/.docker/config.json:/root/.docker/config.json:ro
      - /var/run/docker.sock:/var/run/docker.sock
      - /var/run/cuos.sock:/var/run/cuos.sock
      - /data:/data
      - /dev:/dev
      - /proc:/proc
      - /system.json:/system.json:ro
      - /usr/local/share/ca-certificates/custom:/usr/local/share/ca-certificates/custom:ro
    environment:
      - TZ=Europe/Berlin
    restart: always
```

Add your SSH public key to `system.json`:

```json
{
  "dev-keys": [
    "ssh-rsa AAAA..."
  ]
}
```

Connect via SSH on port 3522:

```bash
ssh -p 3522 root@<host-ip>
```

---

## Splitting your configuration

For larger setups, split `docker-compose.yml` using Docker Compose's `include` directive:

```yaml
include:
  - path: ./cuos-iac-webui/docker-compose.yml
  - path: ./monitoring/docker-compose.yml
  - path: ./my-app/docker-compose.yml
```

Each included file lives in its own subdirectory with its own `docker-compose.yml`. This keeps services modular and independently manageable.

---

## Next steps

- [Configuration Reference](configuration.md) — tune polling intervals, branches, and more
- [Security Guide](security.md) — encrypt secrets and enforce commit signing
- [API Reference](api.md) — automate updates and query system state
