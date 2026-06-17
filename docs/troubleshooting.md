# Troubleshooting

---

## Diagnosing issues

### Check the IaC state

The quickest way to see what's happening:

```bash
echo '{"app_command": "state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock | jq .
```

Look at `iac_state` and `iac_error` for the cause.

### Check container logs

```bash
docker logs cuos-iac
# or follow live:
docker logs -f cuos-iac
```

The IaC container logs all significant events prefixed with `[cuos-iac]`.

### Check running services

```bash
echo '{"app_command": "ps"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock | jq .
# or directly:
docker ps -a
```

---

## Common errors

### `iac_state: "pull repo failed"`

The container could not clone or pull the Git repository.

**Possible causes:**

- Wrong or expired credentials in `iac_repo_url`
- Network connectivity issues
- Repository does not exist
- Branch specified in `iac_repo_branch` does not exist

**Check:**

```bash
docker logs cuos-iac | grep -i "error\|clone\|pull"
```

**Fix:** Update `iac_repo_url` with valid credentials. If you changed the URL, re-run or trigger an update — the container will re-clone automatically when the URL changes.

---

### `iac_state: "verification failed"`

Commit signature verification failed.

**Possible causes:**

- Last commit was not signed
- Signed with a key not listed in `iac_repo_signing_keys`
- The `allowed_signers` file format in `iac_repo_signing_keys` is wrong

**Check:**

```bash
# Verify the commit locally
git log --show-signature -1
```

**Fix:**
- Sign the commit with a configured key, or
- Remove `iac_repo_signing_keys` from `system.json` to disable verification, or
- Add the signing key to `iac_repo_signing_keys`

---

### `iac_state: "docker compose failed"`

`docker compose up` failed.

**Possible causes:**

- Invalid `docker-compose.yml` syntax
- Image pull failed (wrong image name, registry auth missing)
- Image digest mismatch (`x-digest` does not match pulled image)
- Port conflict on the host
- Insufficient disk space

**Check:**

```bash
docker logs cuos-iac | grep -i "error\|compose\|digest"
```

**Debug manually** (from inside the IaC container):

```bash
docker exec -it cuos-iac bash
docker compose -f /volume/repo/docker-compose.yml config   # validate
docker compose -f /volume/repo/docker-compose.yml pull     # test pull
docker compose -f /volume/repo/docker-compose.yml up -d    # test start
```

---

### `iac_state: "docker build failed"`

`docker compose build` failed.

**Possible causes:**

- Build context path does not exist
- Dockerfile errors
- Network issues fetching base images

**Check:**

```bash
docker logs cuos-iac | grep -i "build\|error"
```

---

### `iac_state: "applying system.json failed"`

Could not apply the new `system.json`.

**Possible causes (CuOS mode):**
- CuOS socket at `/var/run/cuos.sock` is unavailable
- JSON syntax error in the merged `system.json`
- CuOS rejected the config update

**Possible causes (standalone mode):**
- `/system.json` is mounted read-only (add a writable bind mount)
- File permission error

**Check:**

```bash
# Validate the repo's system.json:
docker exec cuos-iac bash -c '/app/merge-configs.sh /volume/repo/system.json | jq .'
```

---

### Services not updating after a Git push

**Check if new commits are being detected:**

```bash
echo '{"app_command": "state"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock \
  | jq '{iac_commit, last_iac_update_check}'
```

Compare `iac_commit` with the latest commit in your repository.

**Force an immediate update:**

```bash
echo '{"app_command": "update"}' | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

### Socket not accessible

**Error:** `socat: E connect(5, AF=1 "/socket/cuos-iac.sock", 26): No such file or directory`

**Possible causes:**

- IaC container is not running
- Socket volume is not mounted to the right path

**Check:**

```bash
docker ps | grep cuos-iac
docker inspect cuos-iac | jq '.[0].Mounts[] | select(.Destination == "/socket")'
```

---

### `Warning: No password defined` in logs

The container found `.enc` files but `system_file_password` is not set.

**Fix:** Add `system_file_password` to `system.json`, or remove `.enc` files from the repository if encryption is not needed.

---

### Image digest mismatch

**Error in logs:** `Digest mismatch for <image-name>`

The pulled image does not match the `x-digest` value in `docker-compose.yml`.

**Causes:**
- Image was updated in the registry but `x-digest` was not updated in the repository
- Wrong digest was entered

**Fix:** Update the `x-digest` value in `docker-compose.yml`:

```bash
docker pull <image>:<tag>
docker inspect --format='{{index .RepoDigests 0}}' <image>:<tag>
```

Use the output (everything after `@`) as the new digest value.

---

### Custom CA certificate not trusted

If Git or Docker pulls fail with TLS errors after adding `custom_ca_certs`:

**Check:**

```bash
docker exec cuos-iac update-ca-certificates --fresh
docker exec cuos-iac curl -v https://your-internal-registry/
```

Ensure the certificate in `custom_ca_certs` is a valid PEM-encoded CA certificate (not an end-entity certificate).

---

## Resetting the IaC state

To force a full re-clone and re-apply:

```bash
# Remove the state file and repo
docker run --rm -v iac-volume:/volume busybox sh -c 'rm -rf /volume/state.json /volume/repo'

# Restart the container
docker restart cuos-iac
```

---

## Getting inside the container

For deeper debugging:

```bash
docker exec -it cuos-iac bash
```

Inside the container:
- Config: `cat /system.json | jq .`
- State: `cat /volume/state.json | jq .`
- Repo: `ls /volume/repo/`
- Signing keys: `cat /volume/signing_keys`
- Logs: The container process logs to stderr; use `docker logs` from outside.

---

## Log verbosity

The `entrypoint.sh` runs with `set -x`, so all executed commands are logged. This makes `docker logs` verbose by design — this is intentional for auditability.

To reduce noise in monitoring systems, filter for the `[cuos-iac]` prefix:

```bash
docker logs cuos-iac 2>&1 | grep '\[cuos-iac\]'
```
