# cuos-iac-backup

Optional restic backups for a CuOS IaC device. Design and reasons: [DESIGN.md](DESIGN.md). A device that does not
include this service has no backups and pays nothing for the feature.

## What it does

On a schedule (`backup_schedule`, default 03:00) it

1. asks Docker for running containers with the label `cuos.backup.dump` and runs each dump command inside them,
2. backs up `backup_paths` **and** the dumps with restic (snapshots carry the device's `hostname`),
3. applies `backup_retention` (`restic forget --prune`), unless `backup_forget` is `false`,
4. publishes its status and calls `backup_ping_url` (or `backup_ping_fail_url` when it did not work out).

A repository is created only when there is none at that location. A wrong password, an unreachable target or a lock is an
error, never a reason to initialise something new. `restic check` runs on `backup_check` (default weekly; `off` to skip).

## Configuration (`system.json`)

| Key | Default | Meaning |
|---|---|---|
| `backup_repository` | — | restic repository: a path, `sftp:user@host:/path`, `rest:https://…`, `s3:…`. Required. |
| `backup_password` | — | Required. Keep it in the encrypted secrets **and** somewhere outside the device: without it the backups cannot be read. |
| `backup_env` | `{}` | Environment the target needs (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, …). Names in capitals only. |
| `backup_ssh_key`, `backup_known_hosts` | — | For an sftp target: the private key and the pinned host key (`host ssh-ed25519 AAAA…`). Both or neither; the host key is always checked. |
| `backup_schedule` | `0 3 * * *` | Five field cron expression, in the container's time zone. |
| `backup_paths` | `["/data"]` | Absolute paths **as the container sees them**: mount what you want to back up into it, read-only. |
| `backup_exclude` | `[]` | restic `--exclude` patterns. |
| `backup_retention` | `{daily: 7, weekly: 4, monthly: 6}` | Keys `last`, `hourly`, `daily`, `weekly`, `monthly`, `yearly`. Keeping nothing is refused. |
| `backup_forget` | `true` | `false` for append-only targets: this device then never deletes; prune from the target side. |
| `backup_check` | `weekly` | `daily`, `weekly`, `monthly`, a cron expression, or `off`. |
| `backup_sqlite` | `[]` | SQLite database files (absolute, as the container sees them) that are copied consistently, see below. |
| `backup_dump_timeout_sec` | `3600` | A dump that runs longer is killed and fails the run. |
| `backup_ping_url`, `backup_ping_fail_url` | — | Called with `GET` after a run that is `ok` / not `ok`. |
| `enable_backup` | `true` | `false` stops the container at start. |

## Dumps for databases

Put labels on the service in its own compose definition:

```yml
services:
  postgresql:
    labels:
      cuos.backup.dump: "pg_dumpall -U postgres"
      cuos.backup.dump.name: "postgresql.sql"          # optional, default <service>.dump
      cuos.backup.exclude: "/mnt/data/postgresql"      # optional: the live data files, so the dump is the only copy
  mariadb:
    labels:
      cuos.backup.dump: 'mariadb-dump --all-databases -u root -p"$MARIADB_ROOT_PASSWORD"'
```

The command runs with `sh -c` inside the container (so its environment variables are there), and its output is the dump. A
failing, empty or too slow dump fails the whole run: a backup without its database must not look like success.
`cuos.backup.exclude` patterns (comma or newline separated) are matched against paths **as the backup container sees them**.
Dumps are in the snapshot under `/staging/<name>`.

## SQLite databases

Many small services keep a SQLite file. Copying such a file while the application writes to it can give a broken copy, and most of
these images have no `sqlite3` to dump with. So the backup container reads them itself: list the files in `backup_sqlite` and it takes a copy
with SQLite's own backup (`sqlite3 -readonly <db> ".backup …"`) and checks it (`PRAGMA quick_check`). That works on a
**read-only** mount while the application keeps running; the copies are in the snapshot under `/staging/sqlite/`, and the live file
with its `-wal`, `-shm` and `-journal` is left out of the snapshot.

- A database in WAL mode can be copied while the application has it open (the usual case). A closed one in WAL mode cannot be opened on a read-only mount.
- If the copy fails (missing file, damaged, closed WAL database) the run is `partial`, the reason is in the status, and the file itself is
  backed up as it is, so there is something in the repository.
- A path that does not exist counts as a failure too: it shows a wrong path instead of hiding it.

## Running it

```yml
services:
  cuos-iac-backup:
    image: ghcr.io/cuos-dev/cuos-iac-backup:<tag>
    restart: always
    environment:
      DOCKER_HOST: tcp://dockerproxy:2375        # a Docker proxy that allows CONTAINERS, EXEC and POST, nothing else
      TZ: Europe/Berlin
    volumes:
      - { type: bind, source: "${SYSTEM_CONFIG_PATH:-/system.json}", target: /system.json, read_only: true }
      - { type: volume, source: iac-socket, target: /socket }
      - { type: volume, source: backup-state, target: /data }
      - { type: bind, source: "${DATASTORE_PATH}/zigbee2mqtt", target: /src/zigbee2mqtt, read_only: true }
volumes:
  iac-socket: { name: "${IAC_SOCKET_VOLUME:-iac-socket}", external: true }
  backup-state: {}
```

`backup_paths` is then `["/src"]`. The container is not privileged and has no access to the Docker socket itself, only to the proxy
(without `EXEC` the dump fails with a clear 403, which is what you want to see in the status). `/data` holds restic's cache, the
ssh material and the last status.

## Status and control

- The status (last run and check, dumps with sizes, snapshot count, next run, the repository without credentials) is written to
  `/data/status.json` and sent to the IaC manager as `backup:status:set` (ignored by a manager that does not know it yet).
- The container also listens on `/socket/cuos-backup.sock` for one JSON line: `{"command":"status"}`, `{"command":"snapshots"}` or
  `{"command":"run"}` (back up now). Whoever shares the socket volume can ask: let only an administrator's request through.

## Target: restic rest-server (append-only)

Checked against `restic/rest-server` 0.14 with the backup image (restic 0.18). The server keeps the backups safe from the device:

```yaml
services:
  rest-server:
    image: restic/rest-server:latest
    environment:
      # the image takes its options from OPTIONS (a `command:` would replace the image's start script)
      OPTIONS: "--append-only --private-repos"
    ports: ["<LAN address>:8000:8000"]
    volumes: ["rest-data:/data"]
    restart: unless-stopped
volumes:
  rest-data:
```

One user per device in `/data/.htpasswd` (`htpasswd -B -c … jarvis`, or `docker exec -it rest-server create_user jarvis`); with `--private-repos` that user reaches only `/jarvis/`.
On the device (`system.json`; the two credentials are secrets, in `system_secrets.json` or the environment of the container):

```json
"backup_repository": "rest:http://<nas>:8000/jarvis",
"backup_env": { "RESTIC_REST_USERNAME": "jarvis", "RESTIC_REST_PASSWORD": "<its password>" },
"backup_forget": false
```

What was checked: backup and restore work; `forget --prune` from the device is refused (`403`), so is deleting or overwriting a snapshot or an index
(the files stay); another user, or none, gets `401` on the repository (`/other/` can be created by that user, `/third/` not).
Pruning therefore happens on the server side, as a job with the repository password and full access to the data directory:
`restic unlock --remove-all` (only when no backup runs; a refused prune from the device leaves a lock), then
`restic forget --prune --keep-daily 7 --keep-weekly 4 --keep-monthly 6`. Mind the file owner: the data directory belongs to the server's user, run the job with
`--volumes-from` the rest-server container or as that user.
`--prometheus` (with `--prometheus-no-auth`, otherwise it answers 401) counts reads and writes per repository and type since the server started; there is no "last write" time in it.
Without TLS (`--tls` or a proxy) the user name and password are readable on the network; the backup data are encrypted by restic anyway.

## Restore

By hand, from the device or any machine that has the repository password:

```
docker exec -it cuos-iac-backup sh
restic snapshots
restic restore latest --target /tmp/restore --include /src/zigbee2mqtt
restic dump latest /staging/postgresql.sql | docker exec -i <postgres container> psql -U postgres
```

## Development

`npm test` (here): schedule, configuration, dumps, and whole runs against a real `restic` (skipped if it is not installed) with a stand-in
`docker`. `docker build -t cuos-iac-backup .` builds the image.
