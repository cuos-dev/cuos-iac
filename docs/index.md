# CuOS IaC

**CuOS IaC** is a Git-driven Infrastructure-as-Code manager for [CuOS](https://github.com/cuos-dev/cuos)-based systems. It runs as a Docker container, continuously polls a Git repository, and automatically applies your infrastructure and service definitions to the host system.

It works as the core management layer of CuOS, but can also be used **standalone** on any host with Docker installed.

---

## How it works

```
Git Repository  ──pull──►  CuOS IaC container  ──apply──►  Docker Compose services
                                   │
                                   └──────────────────────►  system.json (host config)
```

1. On startup, the IaC container clones your Git repository.
2. It optionally decrypts encrypted secrets and verifies commit signatures.
3. It merges and applies your `system.json` configuration to the host.
4. It starts or updates all services defined in `docker-compose.yml`.
5. It polls for changes at a configurable interval (default: every 6 hours) and repeats.

---

## Key features

- **GitOps workflow** — your repository is the single source of truth
- **Automatic updates** — changes in Git are applied without manual intervention
- **Secrets encryption** — AES-256-CBC encrypted files (`.enc`) are decrypted at runtime
- **Commit verification** — optional SSH signature enforcement on commits
- **Image digest pinning** — verify pulled images match expected SHA-256 digests
- **Config composition** — split `system.json` across multiple files with `#include`
- **Socket API** — trigger updates, query state, and run system actions remotely
- **CuOS integration** — deep integration with the CuOS system socket and lifecycle hooks
- **Standalone mode** — works without CuOS on any Docker-capable host

---

## Documentation

| Guide | Description |
|-------|-------------|
| [Getting Started](getting-started.md) | Install and run CuOS IaC for the first time |
| [Configuration Reference](configuration.md) | All `system.json` keys explained |
| [Security Guide](security.md) | Encryption, signing, and image digest pinning |
| [Architecture](architecture.md) | Internal components and data flow |
| [API Reference](api.md) | Socket API commands |
| [Standalone Usage](standalone.md) | Run without CuOS |
| [Troubleshooting](troubleshooting.md) | Common problems and solutions |

---

## Quick example

`system.json` (in your IaC Git repository):

```json
{
  "iac_repo_url": "https://token:password@github.com/your-org/your-iac-repo.git",
  "iac_repo_branch": "main",
  "iac_poll_interval": 3600
}
```

`docker-compose.yml` (also in your IaC Git repository):

```yaml
services:
  my-app:
    image: nginx:latest
    ports:
      - "80:80"
    restart: always
```

That's all you need to get started. CuOS IaC will clone the repo, apply the config, and start `my-app` — and keep it updated whenever you push changes.
