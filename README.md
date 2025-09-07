
# CuOS IaC

🚀 CuOS IaC helps you keep your (CuOS-based) systems up-to-date, secure, and easy to manage – no matter where they run. Designed for reliability and automation, CuOS IaC empowers you to define, update, and control your infrastructure and services through simple Git workflows. Whether you manage a single device or a global fleet, CuOS IaC brings modern DevOps practices to your edge and embedded environments.

For more information about CuOS, visit the [CuOS main project](https://github.com/cuos-dev/cuos).

## Main Features

CuOS IaC is an Infrastructure-as-Code (IaC) manager based on [CuOS](https://github.com/cuos-dev/cuos). This project provides a service (Docker container, source code in the `src/` directory) that automatically polls a Git repository and applies changes to the CuOS system. The `docker-compose.yml` file included in this repository is used to define, run and update services.

## Installation & Usage

Add the following keys to your CuOS system.json:

```json
{
    "initial_image": "ghcr.io/cuos-dev/cuos-iac",
    "initial_image_version": "latest",
    "iac_repo_url": "https://token-user:token-password@github.com/your-user/internal-iac-repo.git"
}
```

Push the system.json additionally to your iac-repo as `/system.json`.

Add your services to `docker-compose.yml`:

```yml
services:
  welcome:
    image: docker/welcome-to-docker
    ports:
      - "80:80"
```

Tipp: Split your docker-compose into multiple files:

```yml
include:
  - path: ./cuos-iac-webui/docker-compose.yml
  - path: ./dev-container/docker-compose.yml
  - path: ./my-service/docker-compose.yml
```

### Security improvements

- Use pinned docker container versions everywhere.
- Use digests everywhere:
  - Set `initial_image_digest` to the digest of the image in `system.json`.
  - Set all digest of all image in `system.json`
  - Add `digest` key to each service in `docker-compose.yml`. This is **not** an offical feature of docker-compose.
- GPG-sign your commits. (Upcoming feature: Enable validation by adding validation keys with `"iac-validation-keys": [...]` in `system.json`. If the last commit is not signed, no changes will be applied.)

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
    image: "ghcr.io/cuos-dev/cuos-iac-webui:latest"
    volumes:
      - /var/run/cuos.sock:/var/run/cuos.sock
      - /system.json:/system.json:ro
    ports:
      - "8030:3000"
    restart: always
```

## Optional: Dev-Container

Purpose: Logon to the system to fix issues.

Add the following service to your `docker-compose.yml`:

```yml
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
      - /etc/partition_mode:/etc/partition_mode:ro
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

Recommandation: Set environment variables for git with your ssh key:

```json
{
    "dev-keys": [
        "environment=\"GIT_AUTHOR_NAME=Your Name\",environment=\"GIT_AUTHOR_EMAIL=your-mail@example.com\",environment=\"GIT_COMMITTER_NAME=Your Name\",environment=\"GIT_COMMITTER_EMAIL=your-mail@example.com\" ssh-rsa AAAAB..."
    ]
}
```

Login with ssh:

```shell
git -p 3522 root@mysystem
```

---

## 📄 License

CuOS is open-source and licensed under the MIT License.

Please refer to the LICENSE.txt file for full license details.

## Disclaimer

This software is provided without warranty. See [DISCLAIMER.md](DISCLAIMER.md) for more information.

---

## 🤝 Contributing

We welcome contributions! Please check out our [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
