# Web UI: local development

`npm run dev:mock` starts everything the UI needs without a device:

| Process | What it is |
|---|---|
| `dev/mock-iac.js` | A stand-in for the cuos-iac socket (`iac/api/trigger`): containers in several states, load, logs, a simulated update, the fleet agent status. |
| `app.js` | The real backend, pointed at the mock through `IAC_SOCKET_PATH`, `SYSTEM_JSON` and `PORT`. |
| Vite | The UI with hot reload on <http://127.0.0.1:5173>; `/api` and `/ws` are proxied to the backend and the dev credentials are added for you. |

`dev/system.json` holds the dev users: `admin` / `admin` (admin) and `viewer` / `viewer` (viewer). The page opens as the admin;
`DEV_AUTH=viewer:viewer npm run dev:mock` opens it as the viewer.

## What the mock does

- Containers: running, healthy, unhealthy, starting, an init container that exited with 0, one that failed. Restart/stop/start/remove change them.
- **Every other update fails** (the first one at `compose_up`, with `iac_state: "docker compose failed"` and an error), the next one succeeds and clears it.
- `fleet:status` starts with a demo status; a real fleet agent (or `dev/fleet-status.mjs`) replaces it.

Changes to `app.js` or `dev/mock-iac.js` need a restart, the UI reloads itself.

## Fleet card

```
node dev/fleet-status.mjs '{"state":"pending","enrollment":"waiting","error":"Waiting for an administrator to approve this device."}'
node dev/fleet-status.mjs '{"state":"refused","error":"The server does not accept the fleet secret."}'
node dev/fleet-status.mjs '{"shares":{"resources":true,"iac_state":false,"network":"none","logs":[],"remote_update":false}}'
node dev/fleet-status.mjs '{"updated":"2000-01-01T00:00:00Z"}'      # an agent that stopped: "not reporting"
node dev/fleet-status.mjs reset
```

A real agent (`fleet-agent/`, in the fleet branch) can publish into the same socket:
`CUOS_SYSTEM_JSON=<file> FLEET_UUID_FILE=<f> FLEET_TOKEN_FILE=<f> IAC_SOCKET_PATH=/tmp/cuos-webui-dev/cuos-iac.sock node agent.js`.
Do not leave one running while you try states by hand: it republishes every 30 s.

## Checks

`node dev/e2e-roles.mjs` (with `npm run dev:mock` running) checks the login and the roles. Expected:

- no login 401; `admin/admin` and `viewer/viewer` 200; wrong password and unknown user 401; `config.user` carries the role;
- the viewer gets `ok` for `ps` and `docker:logs` and `forbidden` for `docker:restart`, `update`, `cuos:reboot`, `compose:file`, `config`;
- the admin gets `ok` for all of them; `nope` is `unknown command` for both; an unauthenticated WebSocket is refused with 401.

`npm run build` must pass; the CI also runs the SPDX header check (`.github/scripts/spdx-headers.sh check`) and shellcheck on `*.sh`.
