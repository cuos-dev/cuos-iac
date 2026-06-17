# Security Guide

CuOS IaC provides several layers of security for production deployments. This guide covers each mechanism, when to use it, and how to set it up.

---

## File encryption

Sensitive files in your repository (credentials, certificates, private keys) can be encrypted and stored safely. CuOS IaC decrypts them at runtime before applying changes.

### How it works

Any file with a `.enc` extension is automatically decrypted. The passphrase comes from `system_file_password` in `system.json`.

Encryption uses **AES-256-CBC** with **PBKDF2** key derivation (200,000 iterations).

### Encrypting a file

```bash
openssl enc \
  -aes-256-cbc \
  -pbkdf2 \
  -iter 200000 \
  -in secrets.json \
  -out secrets.json.enc \
  -pass pass:"your-passphrase"
```

Commit `secrets.json.enc` to the repository. Do **not** commit the plaintext `secrets.json`.

### Configuring the passphrase

Set the passphrase in `system.json` on the host (this file should not be in the repository, or if it is, the passphrase field itself can be in an already-decrypted file):

```json
{
  "system_file_password": "your-passphrase"
}
```

### Decrypting a file manually

```bash
openssl enc \
  -d \
  -aes-256-cbc \
  -pbkdf2 \
  -iter 200000 \
  -in secrets.json.enc \
  -out secrets.json \
  -pass pass:"your-passphrase"
```

### Gitignore for decrypted files

CuOS IaC automatically adds decrypted filenames to `.git/info/exclude`, so they won't appear as untracked changes in the working repository on the device. Add the same patterns to `.gitignore` in your development environment:

```
secrets.json
*.key
*.pem
```

---

## Commit signing

When `iac_repo_signing_keys` is set, every commit must be signed by a listed SSH key. Unsigned or incorrectly signed commits are rejected and no changes are applied.

### Why use this

Prevents unauthorized changes from reaching devices even if repository access is compromised. Only commits signed by trusted keys are applied.

### Setting up SSH commit signing

**1. Generate a signing key (or reuse an existing one):**

```bash
ssh-keygen -t ed25519 -C "deploy-key" -f ~/.ssh/deploy_sign
```

**2. Configure Git to sign commits with this key:**

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/deploy_sign
git config --global commit.gpgsign true
```

**3. Add the public key to `system.json`:**

```json
{
  "iac_repo_signing_keys": {
    "deploy-key": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA..."
  }
}
```

**4. Verify locally:**

```bash
git log --show-signature -1
```

### Signing in CI/CD

For automated commit signing in GitHub Actions:

```yaml
- name: Configure Git signing
  run: |
    git config user.signingkey "${{ secrets.DEPLOY_SIGN_PUBKEY }}"
    git config gpg.format ssh
    git config commit.gpgsign true
    echo "${{ secrets.DEPLOY_SIGN_PRIVKEY }}" > /tmp/deploy_sign
    chmod 600 /tmp/deploy_sign
    git config core.sshCommand "ssh -i /tmp/deploy_sign"
```

---

## Image digest pinning

Pinning image digests ensures that pulled images are exactly the versions you intended, even if a tag like `latest` or `1.2.3` is overwritten in the registry.

### Pinning the IaC container itself

Set `initial_image_digest` in `system.json`:

```json
{
  "initial_image": "ghcr.io/cuos-dev/cuos-iac",
  "initial_image_version": "1.2.3",
  "initial_image_digest": "sha256:abc123..."
}
```

### Pinning services in docker-compose.yml

Use the non-standard `x-digest` key on each service. CuOS IaC checks this after pulling:

```yaml
services:
  my-app:
    image: nginx:1.25.3
    x-digest: "sha256:def456..."
    ports:
      - "80:80"
    restart: always
```

If the pulled image's digest does not match, the update is aborted with an error.

### Looking up a digest

```bash
docker pull nginx:1.25.3
docker inspect --format='{{index .RepoDigests 0}}' nginx:1.25.3
# Output: nginx@sha256:def456...
```

Or from a registry without pulling:

```bash
docker manifest inspect nginx:1.25.3 | jq -r '.config.digest'
```

> **Important:** Remember to update digests in your repository whenever you intentionally upgrade an image version.

---

## Signed config updates via API

The [socket API](api.md) `config` command accepts configuration updates signed with an SSH key. This allows secure remote configuration pushes without modifying the Git repository.

### How it works

1. A JSON payload is base64url-encoded and signed with an SSH key.
2. The signature is sent to the IaC socket as a compact JWS token.
3. The IaC container verifies the signature against `iac_repo_signing_keys`.
4. The payload must include an `iat` (issued-at) Unix timestamp. Tokens older than 15 minutes are rejected.

### Creating a signed config token

```bash
# 1. Build the payload
IAT=$(date +%s)
PAYLOAD=$(jq -n --argjson iat "$IAT" --arg name "alice" \
  '{"iat": $iat, "name": $name, "config": {"iac_poll_interval": 1800}}')

# 2. Encode as base64url
PAYLOAD_B64=$(printf '%s' "$PAYLOAD" | base64 -w0 | tr '+/' '-_' | tr -d '=')

# 3. Sign the payload
SIG=$(printf '%s' "$PAYLOAD" | ssh-keygen -Y sign \
  -f ~/.ssh/deploy_sign \
  -n file \
  /dev/stdin | base64 -w0 | tr '+/' '-_' | tr -d '=')

# 4. Assemble the compact token
TOKEN="${PAYLOAD_B64}.${SIG}"

# 5. Send it
echo "{\"app_command\": \"config\", \"config\": \"${TOKEN}\"}" \
  | socat - UNIX-CONNECT:/socket/cuos-iac.sock
```

---

## Container hardening

The IaC container is designed to run with a minimal attack surface. The `dev.cuos.app_command` label encodes the recommended run parameters:

| Flag | Purpose |
|------|---------|
| `--memory 512MB` | Caps memory to prevent resource exhaustion |
| `--read-only` | Root filesystem is read-only |
| `--tmpfs /tmp:rw,size=64m` | Writable `/tmp` limited to 64 MB |
| `--tmpfs /etc/ssl/certs:rw,...,size=16m` | Writable cert store (updated at startup) |

All persistent state goes to the `/volume` Docker volume. Nothing is written to the container filesystem.

---

## Secrets in system.json

`system.json` on the host contains sensitive values (repo credentials, passphrases). Protect it:

- On CuOS: managed by the CuOS runtime; restrict access via filesystem permissions.
- On standalone hosts: `chmod 600 /path/to/system.json` and ensure only the Docker daemon can read it.
- Never store credentials in plain text in the repository. Use `system_file_password` with `.enc` files instead.

---

## Summary: recommended production setup

```json
{
  "iac_repo_url": "https://deploy-token:ghp_xxx@github.com/org/iac.git",
  "iac_repo_branch": "production",
  "iac_repo_signing_keys": {
    "ci-bot": "ssh-ed25519 AAAAC3...",
    "release-manager": "ssh-ed25519 AAAAC3..."
  },
  "system_file_password": "strong-passphrase-from-vault",
  "initial_image_digest": "sha256:...",
  "os_image_digest": "sha256:..."
}
```

And in `docker-compose.yml`, pin all image digests with `x-digest`.
