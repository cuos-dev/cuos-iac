# CuOS IaC

🚀 CuOS IaC keeps your systems up to date and manageable, wherever they run. You
describe the services a device should run in a `docker-compose.yml`, commit it,
and the device follows — one device or a whole fleet, through plain Git.

For CuOS itself, see the [CuOS main project](https://github.com/cuos-dev/cuos).

## What it is

CuOS IaC is the **CuOS Init App** a system gets by default: `cuos-release`'s
`release.json` pins it as `init_image`, so a configuration that includes
`release.json` already runs it. On the device it is one container that polls a
Git repository and applies what it finds there —
[Development Guide](https://github.com/cuos-dev/cuos/blob/HEAD/docs/development-guide.md)
covers when you would replace it with an Init App of your own.

Source: `iac/` (the manager), plus `webui/`, `fleet-server/`, `fleet-agent/` and
`dev-container/` for the optional pieces.

## Getting started

A system is one repository holding two files.
[`iac-hello-world-system`](https://github.com/cuos-dev/iac-hello-world-system#readme)
is exactly that, ready to clone.

**1. Add `cuos-release` as a submodule.** It carries the pinned versions and the
compose files for the optional components:

```sh
git submodule add https://github.com/cuos-dev/cuos-release.git
```

**2. Write `system.json`** — the system itself, and the repository it follows:

```json
{
    "#include": ["cuos-release/release.json"],
    "hostname": "my-system",
    "iac_repo_url": "https://github.com/your-org/your-iac-repo.git",
    "iac_repo_branch": "main"
}
```

`release.json` already pins `init_image` to CuOS IaC, so nothing further is
needed to get the manager itself.

**3. Write `docker-compose.yml`** — your services, plus the optional components
you want. Include those from the submodule rather than copying YAML into your
file: the shipped files carry the matching version, its digest, and the volumes
and sockets each component needs to work.

```yml
include:
  - path: ./cuos-release/cuos-iac-webui/docker-compose.yml
  - path: ./cuos-release/cuos-dev-container/docker-compose.yml

services:
  welcome:
    image: docker/welcome-to-docker
    x-digest: "sha256:..."
    ports:
      - "80:80"
```

**4. Commit and push**, then build a system from the same `system.json` with
[cuos-release](https://github.com/cuos-dev/cuos-release#readme):

```sh
./cuos-release/tool.sh image system.json
```

The finished device clones the repository, applies the compose file, and keeps
following the branch. One repository is both the system definition and its
deployment source.

> `system.json` has to reach the device **and** the repository: the artefact is
> built from it, and it is committed as `/system.json` beside the compose file.

## How the device follows the repository

1. Pull the repository (`iac_repo_branch`, `iac_repo_subdir`).
2. Verify the last commit's signature, if signers are configured.
3. Check each service's `x-digest` against the image that was pulled.
4. Bring the compose file up.
5. Sleep `iac_poll_interval`, then start over.

The interval is shortened by a random few minutes, so a fleet does not hit the
registry in lockstep. `cuos trigger-update` on the device, the WebUI's button and
`tool.sh update-iac-local` all wake the loop early.

## Configuration

All of these live in `system.json`.

| Key | Default | Meaning |
|---|---|---|
| `iac_repo_url` | — | The repository to poll. Required. |
| `iac_repo_branch` | the repository's default | Branch to follow. |
| `iac_repo_subdir` | repository root | Subdirectory holding the compose file, for one repository serving several systems. |
| `iac_poll_interval` | `21600` (6 h) | Seconds between pulls. |
| `iac_manual_updates` | `false` | `true` never polls; the device updates only when triggered. |
| `iac_repo_signing_keys` | — | Allowed commit signers, see below. |

The manager writes `iac_state`, `iac_commit`, `iac_error` and `iac_error_date`
back into the configuration. Read them; do not set them.

> **Everything in `system.json` ends up in the built artefact and in your IaC
> repository.** A token inside `iac_repo_url` is therefore in both. Use a deploy
> key, or encrypt the value with
> [`tool.sh config-encrypt`](https://github.com/cuos-dev/cuos-release#readme).

## Securing the deployment

The device runs what the repository says, so three things decide who can change
what runs.

**Pin every image and give it a digest.** A tag can be moved; a digest cannot.
The key is `x-digest`, a CuOS IaC extension — plain docker-compose has no
per-service digest field, and ignores unknown `x-` keys:

```yml
services:
  my-service:
    image: "ghcr.io/your-org/my-service:1.2.3"
    x-digest: "sha256:..."
```

A service without `x-digest` is pulled unchecked, and the manager says so in its
log rather than refusing. Remember to update the digest when you move the
version.

**Sign your commits and name the signers.**

```json
{
    "iac_repo_signing_keys": {
        "you@example.com": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
    }
}
```

These are **SSH** signatures: the keys become a git `allowedSignersFile` and the
manager runs `git verify-commit HEAD` (`iac/entrypoint.sh:144`). A commit that
does not verify is not applied, and `iac_state` becomes `verification failed`.

A plain array of keys works too — git matches the signature against the keys in
the file — but the map above is what an `allowed_signers` file looks like, and
it says who each key belongs to.

**Leave the key out and no verification happens at all** — every commit is
applied, with no message and no state saying so. Treat it as part of any setup
you would call production.

**Keep the repository private, or assume it is public.** It holds `system.json`,
which describes the whole system.

## Optional: WebUI

`webui/` — a web interface on port 8030: when the next pull is due, a button to
trigger one now, `docker ps` as a table, CPU/RAM/disk/uptime, the system log, and
the CuOS actions (shutdown, reboot, rollback, factory reset).

```yml
include:
  - path: ./cuos-release/cuos-iac-webui/docker-compose.yml
```

## Optional: Fleet

`fleet-agent/` runs on each device and connects to `fleet-server/`, which you run
yourself — the server is not part of a device's compose file and ships none of
its own. It listens on `FLEET_SERVER_PORT`, default 8085.

```yml
include:
  - path: ./cuos-release/cuos-iac-fleet-agent/docker-compose.yml
```

| Key | Default | Meaning |
|---|---|---|
| `fleet_server_url` | — | Where the agent connects. Without it the agent exits. |
| `fleet_secret` | `changeme` | Shared secret for the connection. **Change it.** |
| `fleet_tags` | `[]` | Labels this device carries, for grouping. |
| `fleet_uuid` | generated | Pin the device's identity; otherwise one is generated into `/data/state_fleet_uuid`. |

## Optional: Dev-Container

`dev-container/` — an SSH login on the running system, for what cannot be fixed
from the repository. It is privileged and shares the host's network, PID
namespace and docker socket: a debugging tool, not something to leave running on
a device you are not working on.

```yml
include:
  - path: ./cuos-release/cuos-dev-container/docker-compose.yml
```

Add the keys that may log in:

```json
{
    "dev-keys": [
        "ssh-ed25519 AAAA..."
    ]
}
```

A key may carry `authorized_keys` options, which is where to set a git identity
for commits made from the device:

```json
{
    "dev-keys": [
        "environment=\"GIT_AUTHOR_NAME=Your Name\",environment=\"GIT_AUTHOR_EMAIL=you@example.com\" ssh-ed25519 AAAA..."
    ]
}
```

```sh
ssh -p 3522 root@my-system
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
