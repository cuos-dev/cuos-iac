# Standalone Usage

CuOS IaC can run on any Linux host with Docker installed — no CuOS required. In standalone mode, `system.json` is written directly to disk instead of being sent to the CuOS runtime socket.

---

## Prerequisites

- Linux host with Docker Engine installed
- `socat` installed on the host (for interacting with the socket API)
- A Git repository containing your `system.json` and `docker-compose.yml`

---

## Initial setup

### 1. Create system.json on the host

Create a minimal `/etc/cuos/system.json` (or any path you prefer):

```json
{
  "iac_repo_url": "https://token:ghp_yourtoken@github.com/your-org/your-iac-repo.git",
  "iac_repo_branch": "main",
  "iac_poll_interval": 3600
}
```

Restrict access:

```bash
chmod 600 /etc/cuos/system.json
```

### 2. Create Docker volumes

```bash
docker volume create iac-volume
docker volume create iac-socket
```

### 3. Run the IaC container

```bash
docker run -d \
  --name cuos-iac \
  --restart unless-stopped \
  --memory 512MB \
  --read-only \
  --tmpfs /etc/ssl/certs:rw,noexec,nosuid,size=16m \
  --tmpfs /tmp:rw,size=64m \
  --volume /var/run/docker.sock:/var/run/docker.sock \
  --volume /root/.docker/config.json:/root/.docker/config.json:ro \
  --volume iac-socket:/socket \
  --volume iac-volume:/volume \
  --volume /etc/cuos/system.json:/system.json:ro \
  ghcr.io/cuos-dev/cuos-iac:latest
```

### 4. Verify

```bash
docker logs cuos-iac
```

You should see the repository being cloned and services starting.

---

## Differences from CuOS mode

| Feature | CuOS mode | Standalone mode |
|---------|-----------|-----------------|
| `system.json` updates | Sent to CuOS via socket | Written directly to disk |
| OS updates | Managed by CuOS | Not applicable |
| `cuos:*` API commands | Forwarded to CuOS | Return empty (CuOS socket absent) |
| Bootstrap | `initial_image` in system.json | Manual `docker run` |
| Container lifecycle | Managed by CuOS | Managed by Docker restart policy |

The IaC container detects whether it is running on CuOS by checking for the presence of `/var/run/cuos.sock`. If the socket exists, it operates in CuOS mode; otherwise it operates in standalone mode.

---

## Updating system.json in standalone mode

When a new `system.json` is detected in the repository, the IaC container writes it directly to the path mounted at `/system.json`. Since this is a read-only bind mount, the host file at that path is updated.

> **Note:** The file must be writable on the host for standalone mode config updates to work. Either use a writable bind mount, or manage `system.json` updates manually.

To use a writable bind mount (remove `:ro`):

```bash
--volume /etc/cuos/system.json:/system.json
```

---

## Running as a Docker Compose service

For reproducible deployments, define the IaC container in a `docker-compose.yml` on the host:

```yaml
services:
  cuos-iac:
    image: ghcr.io/cuos-dev/cuos-iac:latest
    restart: unless-stopped
    mem_limit: 512m
    read_only: true
    tmpfs:
      - /etc/ssl/certs:rw,noexec,nosuid,size=16m
      - /tmp:rw,size=64m
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /root/.docker/config.json:/root/.docker/config.json:ro
      - iac-socket:/socket
      - iac-volume:/volume
      - /etc/cuos/system.json:/system.json:ro

volumes:
  iac-volume:
  iac-socket:
```

Start with:

```bash
docker compose up -d
```

---

## Triggering updates from the host

Install `socat` on the host:

```bash
apt-get install -y socat
```

The IaC socket is accessible through the `iac-socket` volume. Find the volume's mountpoint:

```bash
docker volume inspect iac-socket --format '{{.Mountpoint}}'
# Example: /var/lib/docker/volumes/iac-socket/_data
```

Send a command:

```bash
SOCKET_DIR=$(docker volume inspect iac-socket --format '{{.Mountpoint}}')
echo '{"app_command": "update"}' | socat - UNIX-CONNECT:${SOCKET_DIR}/cuos-iac.sock
```

Or run socat from within the IaC container:

```bash
docker exec cuos-iac sh -c 'echo "{\"app_command\": \"state\"}" | socat - UNIX-CONNECT:/socket/cuos-iac.sock'
```

---

## Using a custom system.json path

Set the `SYSTEM_CONFIG_PATH` environment variable if your `system.json` is not at the default `/system.json`:

```bash
docker run -d \
  --name cuos-iac \
  --env SYSTEM_CONFIG_PATH=/config/my-system.json \
  --volume /my/path/config.json:/config/my-system.json:ro \
  ... \
  ghcr.io/cuos-dev/cuos-iac:latest
```

---

## Monitoring and logs

View IaC container logs:

```bash
docker logs -f cuos-iac
```

Query IaC state:

```bash
SOCKET_DIR=$(docker volume inspect iac-socket --format '{{.Mountpoint}}')
echo '{"app_command": "state"}' | socat - UNIX-CONNECT:${SOCKET_DIR}/cuos-iac.sock | jq .
```

List running services:

```bash
SOCKET_DIR=$(docker volume inspect iac-socket --format '{{.Mountpoint}}')
echo '{"app_command": "ps"}' | socat - UNIX-CONNECT:${SOCKET_DIR}/cuos-iac.sock | jq .
```
