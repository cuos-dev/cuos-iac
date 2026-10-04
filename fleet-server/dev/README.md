# Fleet server: local development

```
npm install && (cd webui && npm install)
npm run dev:mock
```

starts, with a fresh database in `$TMPDIR/cuos-fleet-dev` each time:

| Process | What it is |
|---|---|
| `server.js` | The real server (port 8085) with the dev settings of `dev/run.js`. |
| `dev/fake-agents.js` | 18 fake agents speaking the real protocol, using the real `fleet-agent/share.js` and `redact.js`. |
| `dev/seed-history.js` | A week of load history for them, so the 24 h and 7 d charts have data. |
| Vite | The UI with hot reload at <http://127.0.0.1:5173/ui/> (the next free port if it is taken); `/api` and `/ui-ws` are proxied. |

Credentials (`dev/users.json`): `admin` / `admin` (admin), `viewer` / `viewer` (viewer); API keys `dev-admin-key`, `dev-ro-key`;
agent secret `dev-fleet-secret`. `DEV_AUTH=viewer:viewer npm run dev:mock` opens the UI as the viewer, `FLEET_NAME=production` sets the title suffix.
A runner started from a script can be stopped with `kill $(pgrep -f '^node dev/run.js')` (anchored: an unanchored pattern also matches your own shell).

## The fake agents

`i` is the index in `dev/fake-agents.js`; the hostname is `<name>-<i+1>`.

- backup status (what the optional backup container would report): failed `i % 11 === 1`, incomplete 3, running 5, overdue 7, none at all 2 and 10, otherwise ok; device 8 does not share it;
- offline after the first report: `i % 7 === 5`; failing IaC state (`docker compose failed`): `i % 8 === 3`; updates fail: `i % 5 === 4`;
- loses its token once after 12 s and has to be approved again (`amnesia`): `i === 11`, `i === 16`;
- privacy profiles: network `full` (4, 1, 10), `none` (7); no load shared (6); no IaC state (8); remote update refused (2, 10);
  logs `iac` (0, 3, 9, 12), `iac` + `system` (6, 15; 15 also masks IP addresses). Log lines contain a password and a URL credential on purpose: they must arrive scrubbed.

## Checks

Unit tests: `npm test` (here: `store.js`; in `../fleet-agent`: sharing and scrubbing).

End to end, against the running dev server (every script uses fresh ids, so it can run again):

| Script | Expected |
|---|---|
| `node dev/e2e-auth.mjs` | no login 401; admin/viewer 200, wrong password 401; admin key and read-only key 200, bad key 401; update as viewer or read-only key 403, as admin 200; UI files need a login; the agent socket accepts the secret as `Authorization: Bearer`, has no use for it in the URL (that is protocol 1, see `e2e-legacy`) and refuses a wrong or missing one (401); a hello with an injected uuid is closed with `1008 invalid uuid`. |
| `node dev/e2e-enrollment.mjs` | the bootstrap secret with the id of an enrolled device **waits**, gets no token, changes nothing, can report nothing; reject drops the request; a token of one device claiming another id is closed (`1008`) and its messages for another device are ignored; revoke closes the connection, the old token is `401 token_unknown`, the secret again waits, approve hands out a new token; rotate delivers one, the old token works until the new one was used once; the viewer gets 403 on approve, reject, revoke, rotate. |
| `node dev/e2e-legacy.mjs` | a protocol 1 agent (`/ws/<secret>`, no token) is welcomed without a token, is online with state `legacy`, its metrics are kept unscrubbed (`shares: null`), update triggers reach it; the credentials in its repository URL are dropped, a version that is an image reference becomes its tag, and its own address (`primary_ip`) is told apart from the gateway; it cannot speak for another id; a wrong secret or other path is 401, a protocol 2 hello on the old path is closed; a device that has a token closes an old agent with its id (`device has a token`); revoke closes a legacy device and keeps it out; an upgraded agent gets a token for the id of its legacy record. |
| `node dev/e2e-backup.mjs` | a device that shares its backup status gets a cleaned copy stored (result, a count of dumps, snapshots; no repository, container names or extra fields); one that does not share it has nothing stored; a status that is not an object is dropped. |
| `node dev/e2e-intake.mjs` | load samples become history (1 h, 24 h and 7 d series, about 168 hourly buckets for a seeded device); only announced log sources are stored, lines are cut at 2000 characters, a bad priority becomes 6, an old timestamp becomes now; a burst of 5000 lines stores about 2000; a 1.2 MB frame closes the connection with 1009 and the server stays up; filters by text, source and level; the viewer and the read-only key get 403 on logs; the live stream delivers matching lines; forgetting a device deletes its record, history and logs (admin only). |

`npm run build` in `webui/` must pass. The CI also runs the SPDX header check and shellcheck on `*.sh`.
