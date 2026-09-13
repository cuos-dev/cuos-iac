# CuOS IaC

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE.txt)

🚀 **Infrastructure as Code for devices.** What a system should run — services,
versions, configuration — lives in a Git repository. Each device pulls it,
checks that it is genuine, and applies it to itself.

For CuOS itself, see the [CuOS main project](https://github.com/cuos-dev/cuos).

## What it is

The direction is what sets it apart from most IaC tooling: **nothing pushes to a
device.** A device holds its own configuration, decides when to act on a change,
and needs no server to be reachable in order to keep working. From a single
Raspberry Pi to a few dozen machines.

- **Git is the source of truth.** Every deployment traces back to a commit, and
  commits can be required to carry a signature the device knows.
- **The device decides.** It pulls, verifies and applies locally. There is no
  control plane that can deploy onto it.
- **Offline-first.** Cut off from Git, a device keeps running what it last
  applied, for as long as it takes.
- **Optional by parts.** Deploying needs the manager and nothing else. A local
  web interface, fleet-wide visibility and an SSH debugging container are each
  something you add when you want it.

| Part | What it does |
|---|---|
| `iac/` | The manager. Runs on the device: pull, verify, apply, repeat. |
| `webui/` | A web interface for one device: state, logs, trigger an update, reboot. |
| `fleet-agent/`, `fleet-server/` | Many devices reporting to one place. Visibility and convenience — still early, and deliberately not a way to push. |
| `dev-container/` | SSH onto a running device, for what cannot be fixed from the repository. |

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

### Where the manager sits on a CuOS system

CuOS starts exactly one container of its own and leaves the rest to it — the
**CuOS Init App**, named by `init_image`. The manager in `iac/` is one of those,
and the one `cuos-release`'s `release.json` pins, which is why including
`release.json` is all it takes to get it.

That is the seam: anything that can be an Init App can replace it. Writing your
own update or deployment mechanism means building one instead of using this —
see the
[Development Guide](https://github.com/cuos-dev/cuos/blob/HEAD/docs/development-guide.md).
It also means CuOS IaC is not limited to CuOS: the manager is a container
talking to a docker socket, and `tool.sh start-iac-local` runs it on any docker
host.

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

**Sign your commits and list the keys that may sign them.**

```json
{
    "iac_repo_signing_keys": [
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA...",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAB..."
    ]
}
```

These are **SSH** signatures: the keys become a git `allowedSignersFile` and the
manager runs `git verify-commit HEAD` (`iac/entrypoint.sh:144`). A commit that
does not verify is not applied, and `iac_state` becomes `verification failed`.
A commit signed by a key that is not listed is rejected with
`No principal matched`.

What is checked is the **key**. Any listed key verifies any commit, whoever
authored it — this is a list of keys that may deploy, not a record of who may
deploy as whom. Remove a key from the list to remove that person's access.

**Leave the key out and no verification happens at all** — every commit is
applied. An **empty list counts as left out**, and so does a misspelled key
name: all three look exactly like a system that is protected. The manager says
which mode it is in when it starts (`cuos:iac:commit_verification_off`), so
check that once rather than trusting the spelling.

The keys may be given with or without their trailing comment, as copied from a
`.pub` file; both are accepted.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions need a Developer
Certificate of Origin sign-off (`git commit -s`, see [DCO.txt](DCO.txt)).

## License

Apache-2.0 — see [LICENSE.txt](LICENSE.txt) and [NOTICE](NOTICE). Each source
file carries an `SPDX-License-Identifier` line.
No warranty; see [DISCLAIMER.md](DISCLAIMER.md).
