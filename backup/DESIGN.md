# Backup (restic): design

Status: the container (`agent.js`, `job.js`, ...) is built and tested; the status in the IaC manager (`backup:status`), the web UI card and the release compose file are still to do. See [README.md](README.md) for what exists.

## Goals

- Back up the *state* of a device (runtime data and configs of its services). The *definition* of the system is
  already in the IaC repository and needs no backup.
- **Optional.** A system that does not want backups gets no container, no load and no keys in `system.json`.
- Databases are backed up from a **dump**, not by copying files that are in use, and not by stopping the database.
- The target is the owner's choice: sftp/ssh, a NAS, S3, or a restic rest-server. Nothing here depends on one of them.
- Failures are visible: in the web UI and, optionally, in a monitoring tool.

## Shape

A separate component, like the fleet agent, not part of the IaC manager:

- `backup/` in this repository: a small image (restic, a scheduler, a shell script) built by its own workflow and
  published with the other images.
- `cuos-release/cuos-iac-backup/docker-compose.yml` (in the release repository) defines the service. A device that wants
  backups includes it next to the web UI and the fleet agent. Not including it switches the feature off.
- It talks to the IaC manager only through the socket (`/socket/cuos-iac.sock`) to publish its status, the way the fleet
  agent does with `fleet:status:set`.

## Configuration (`system.json`)

| Key | Default | Meaning |
|---|---|---|
| `backup_repository` | none | restic repository URL (`sftp:user@host:/path`, `rest:https://…`, `s3:…`, or a local/NFS path). Without it the container exits. |
| `backup_password` | none | The repository password. Belongs into the encrypted secrets. **If it is lost the backups are lost:** keep a copy outside the device. |
| `backup_env` | `{}` | Credentials the repository type needs (`AWS_ACCESS_KEY_ID`, …); sftp uses `backup_ssh_key`. Also secrets. |
| `backup_ssh_key`, `backup_known_hosts` | none | For sftp targets; the host key is pinned, never accepted blindly. |
| `backup_schedule` | `0 3 * * *` | When to back up (cron syntax). |
| `backup_paths` | `["/data"]` | What to back up. Paths of the datastore are mounted read-only into the container. |
| `backup_exclude` | `[]` | restic exclude patterns. |
| `backup_retention` | `{ "daily": 7, "weekly": 4, "monthly": 6 }` | What `forget` keeps. |
| `backup_forget` | `true` | Whether this device prunes at all. Turn it off for append-only targets (see below). |
| `backup_check` | weekly | How often `restic check` runs. |
| `backup_ping_url` | none | Called with success or failure after each run (healthchecks / Uptime Kuma push style). |

## Databases

A file copy of a running database can be inconsistent, and stopping it for the backup is the worst option for a service
that is expected to stay up. So the backup takes a **dump** from the live database:

- A container declares how it is dumped with labels, next to the rest of its compose definition:

  ```yml
  services:
    postgresql:
      labels:
        cuos.backup.dump: "pg_dumpall -U postgres"
        cuos.backup.dump.name: "postgresql.sql"      # optional, default <service>.dump
  ```

- Before the run the backup container executes each command with `docker exec` in the labelled container, writes the
  output to a staging directory (`/staging`, a volume that is part of `backup_paths`) and removes it afterwards.
  A failed dump fails the run (no silent, empty "backup").
- The database's own data directory is **excluded** (label `cuos.backup.exclude`), so the dump is the single source.
- Files that are consistent on their own (zigbee2mqtt's data, most configs) are simply part of `backup_paths`.
  SQLite files that are written all the time get a dump label as well (`sqlite3 … ".backup '…'"`).
- Docker access goes through the Docker proxy that the device already runs, limited to `exec` and `inspect`;
  the container is not privileged and does not get the raw socket.

## Status and the web UI

The container publishes a small status through the socket (`backup:status:set`, read with `backup:status`, stored in
`/volume/backup.json`, kept small, never containing a credential): time and result of the last run and of the last
check, duration, size, number of snapshots, repository without credentials, next run.

The web UI shows a **Backup** card only when a status exists (same rule as the Fleet card) and gives an administrator
"Back up now". A viewer sees the status only. Restoring is **not** a button (see below).

## Restore

Phase 1: documented, by hand, from the device or any machine that has the repository password:
`restic snapshots`, `restic restore latest --target …`, and loading a dump with the database's own tool.
The UI lists snapshots (read only).

Phase 2 (later, only with the owner's explicit opt-in): on a device with an empty datastore, a one-shot init service restores
the latest snapshot **before** the other services start. Overwriting existing data from the UI is deliberately not planned.

## Security notes

- A device that can write to a repository can usually also delete from it. For targets that allow it, use **append-only**
  (rest-server `--append-only`, object lock, or an sftp user that may only append) and set `backup_forget: false`; pruning
  then runs on the target side, from a machine the device cannot reach.
- The password and the target credentials never leave the encrypted secrets; the status never contains them.
- The ssh host key of an sftp target is pinned in `backup_known_hosts`.
- The container reads data read-only and has no network access except to the target and the optional ping URL.
- Backups can contain secrets of the services (tokens, certificates). The repository password is the only protection:
  choose a long one.

## Open questions

- Where is the target (NAS, server over sftp, rest-server)? It decides append-only and how credentials are delivered.
- Exactly which services on a device need which dump command (a table per example system would be a good addition).
- Whether the fleet server should get the status, so a fleet shows "last backup" per device (a `fleet_share` option).
- Scheduling inside the container (a small loop or `supercronic`) and timezone handling.
- Multiple repositories per device (a second copy elsewhere): restic can do it with `copy`; not planned for the first version.

## Plan

1. `backup/` image: restic, scheduler, dump hooks from labels, status through the socket; tests against a local repository
   and a throw-away postgres/mariadb container.
2. `iac/api/trigger`: `backup:status` / `backup:status:set`, the same shape as the fleet status.
3. Web UI: Backup card and "back up now".
4. Release: workflow, `cuos-release/cuos-iac-backup`, documentation in the main README.
5. Later: restore into an empty datastore, fleet integration.
