
# CuOS IaC

🚀 CuOS IaC helps you keep your (CuOS-based) systems up-to-date, secure, and easy to manage – no matter where they run. Designed for reliability and automation, CuOS IaC empowers you to define, update, and control your infrastructure and services through simple Git workflows. Whether you manage a single device or a global fleet, CuOS IaC brings modern DevOps practices to your edge and embedded environments.

For more information about CuOS, visit the [CuOS main project](https://github.com/cuos-dev/cuos).

## Main Features

CuOS IaC is an Infrastructure-as-Code (IaC) manager based on [CuOS](https://github.com/cuos-dev/cuos). This project provides a service (Docker container, source code in the `iac/` directory) that automatically polls a Git repository and applies changes to the CuOS system. The `docker-compose.yml` file in *your* repository is what defines, runs and updates your services.

It is the **CuOS Init App** a system gets by default: `cuos-release`'s `release.json` pins it as `init_image`, so a configuration that includes it already runs CuOS IaC. See the [Development Guide](https://github.com/cuos-dev/cuos/blob/HEAD/docs/development-guide.md) for when you would replace it with one of your own.

## Installation & Usage

Add the following keys to your CuOS system.json:

```json
{
    "init_image": "ghcr.io/cuos-dev/cuos-iac",
    "init_image_version": "v0.4.0",
    "iac_repo_url": "https://token-user:token-password@github.com/your-user/internal-iac-repo.git"
}
```

Push the system.json additionally to your iac-repo as `/system.json`.

> **The whole `system.json` is baked into the built artefact and committed to
> your IaC repository.** A token in `iac_repo_url` therefore ends up in both.
> Use a deploy key, or encrypt the value —
> [`tool.sh config-encrypt`](https://github.com/cuos-dev/cuos-release#readme).

### Configuration keys

| Key | Default | Meaning |
|---|---|---|
| `iac_repo_url` | — | The repository to poll. Required. |
| `iac_repo_branch` | the repository's default | Branch to follow. |
| `iac_repo_subdir` | repository root | Subdirectory holding the `docker-compose.yml`, for a repository serving several systems. |
| `iac_poll_interval` | `21600` (6 h) | Seconds between pulls. |
| `iac_manual_updates` | `false` | `true` never polls; updates happen only when triggered. |
| `iac_repo_signing_keys` | — | Allowed signers, see below. |

The manager also *writes* `iac_state`, `iac_commit`, `iac_error` and
`iac_error_date` back into the configuration — read them, do not set them.

Add your services to `docker-compose.yml`:

```yml
services:
  welcome:
    image: docker/welcome-to-docker
    ports:
      - "80:80"
```

Tip: Split your docker-compose into multiple files. The optional components
below ship as ready-made compose files in
[cuos-release](https://github.com/cuos-dev/cuos-release#readme) — add it to your
IaC repository as a submodule and include them from there, versions and digests
already pinned:

```yml
include:
  - path: ./cuos-release/cuos-iac-webui/docker-compose.yml
  - path: ./cuos-release/cuos-iac-fleet-agent/docker-compose.yml
  - path: ./cuos-release/cuos-dev-container/docker-compose.yml
  - path: ./my-service/docker-compose.yml
```

[`iac-hello-world-system`](https://github.com/cuos-dev/iac-hello-world-system#readme)
is a working repository of exactly that shape.

### Security improvements

- Use pinned docker container versions everywhere.
- Use digests everywhere:
  - Set `init_image_digest` to the digest of the image in `system.json`.
  - Set all digest of all image in `system.json`
  - Add `digest` key to each service in `docker-compose.yml`. This is **not** an offical feature of docker-compose.
- **Sign your commits, and list the signers.** This is implemented, not upcoming:

  ```json
  {
      "iac_repo_signing_keys": [
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
      ]
  }
  ```

  Signatures are **SSH** signatures — the keys become a `git`
  `allowedSignersFile` and the manager runs `git verify-commit HEAD`
  (`iac/entrypoint.sh:144`). A commit that does not verify is not applied, and
  `iac_state` becomes `verification failed`.

  **It fails open:** with the key absent or the list empty, no verification
  happens at all and every commit is applied. An unsigned deployment is
  therefore a configuration you have to opt out of, not one you fall into by
  making a mistake — but it is also not the default.

Be aware, that you have to update the digest on image updates.

## Optional: WebUI

The `webui/` directory contains an optional web interface, which is provided as a separate Docker container. The WebUI offers the following features:

- Display when the next pull/update will occur
- Trigger pull & update manually
- Show `docker ps` as a table
- Show system stats: CPU, RAM, disk usage, last update time, system uptime, system logs, etc.
- Perform system and CuOS actions: shutdown, reboot, rollback, factory reset

To enable it, add the following service to your `docker-compose.yml` file:

```yml
services:
  cuos-iac-webui:
    image: "ghcr.io/cuos-dev/cuos-iac-webui:v0.4.0"
    volumes:
      - /var/run/cuos.sock:/var/run/cuos.sock
      - /system.json:/system.json:ro
    ports:
      - "8030:3000"
    restart: always
```

## Optional: Fleet

`fleet-server/` and `fleet-agent/` manage many systems at once: the agent on
each device opens a websocket to a server you run, which sees the fleet's state
and can reach into it.

Configure the agent in `system.json`:

| Key | Default | Meaning |
|---|---|---|
| `fleet_server_url` | — | The server the agent connects to. Without it the agent exits. |
| `fleet_secret` | `changeme` | Shared secret for the connection. **Change it.** |
| `fleet_tags` | `[]` | Labels this device carries, for grouping. |
| `fleet_uuid` | generated | Pin the device's identity; otherwise one is generated and kept in `/data/state_fleet_uuid`. |

Enable the agent by including
`cuos-release/cuos-iac-fleet-agent/docker-compose.yml`, as above. The server is
run wherever you want it, not on the device.

## Optional: Dev-Container

Purpose: Logon to the system to fix issues.

Add the following service to your `docker-compose.yml`:

```yml
services:
  cuos-dev-container:
    image: "ghcr.io/cuos-dev/cuos-iac-dev-container:v0.4.0"
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

Add your SSH key(s) to system.json:

```json
{
    "dev-keys": [
        "ssh-rsa AAAA..."
    ]
}
```

Recommendation: Set environment variables for git with your ssh key:

```json
{
    "dev-keys": [
        "environment=\"GIT_AUTHOR_NAME=Your Name\",environment=\"GIT_AUTHOR_EMAIL=your-mail@example.com\",environment=\"GIT_COMMITTER_NAME=Your Name\",environment=\"GIT_COMMITTER_EMAIL=your-mail@example.com\" ssh-rsa AAAAB..."
    ]
}
```

Login with ssh:

```shell
ssh -p 3522 root@mysystem
```

---

## 📄 License

CuOS IaC is open-source and licensed under the **Apache License, Version 2.0**.

Please refer to the [LICENSE.txt](LICENSE.txt) file for full license details, and to [NOTICE](NOTICE) for attribution. Each source file carries an `SPDX-License-Identifier` line.

## Disclaimer

This software is provided without warranty. See [DISCLAIMER.md](DISCLAIMER.md) for more information.

---

## 🤝 Contributing

We welcome contributions! Please check out our [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
