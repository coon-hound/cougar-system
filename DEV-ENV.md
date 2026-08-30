# Local dev environment

A real Postgres, the real Edge Function and the real frontend, running on this
machine. No Docker, no `sudo`, no Supabase account, no cloud, and no production
data — so the Sheets → Postgres migration can be rehearsed, broken and re-run as
often as you like before anything is cut over.

```
./scripts/dev-env.sh up       # start everything (creates the DB on first run)
node scripts/dev-seed.mjs     # synthetic people to click around
npm run test:live             # the backend contract, against the real thing
./scripts/dev-env.sh down     # stop everything
```

`up` prints the two `localStorage` lines that point the app at the local
backend. Paste them into the browser console once and reload.

## What is running

| Piece | Where | How it starts |
|---|---|---|
| Postgres 16.15 | `127.0.0.1:55432`, db `cougar_dev`, user `cougar` (trust auth) | `pg_ctl`, data in `~/.local/pgsql/data` |
| Edge Function | `127.0.0.1:8000` | `deno run supabase/functions/api/index.ts` |
| Frontend | `127.0.0.1:5600` | `python3 -m http.server` over the repo root |

Logs are in `~/.cougar-dev/` (`edge.log`, `web.log`, `postgres.log`);
`./scripts/dev-env.sh logs` tails the Edge Function.

The dev secrets are in `scripts/dev-env.sh` in plain sight — `COUGAR_ENC_KEY` is
the literal string `local-dev-key` and the auth token is `dev-token`. They are
deliberately worthless, because the database they protect holds nothing real.
No deployment should ever reuse either.

## The toolchain (installed without sudo)

Everything lives under `~/.local` and was assembled by unpacking Ubuntu
packages into a private root, so nothing was installed system-wide:

```bash
# Postgres 16 + client + the libraries they need
mkdir -p ~/.local/pgsql/debs && cd ~/.local/pgsql/debs
apt-get download postgresql-16 postgresql-client-16 postgresql-common \
                 libpq5 libicu74 libllvm17t64
for d in *.deb; do dpkg -x "$d" ~/.local/pgsql/root; done

# Deno (the Edge Function runtime) and Node 20 (scripts + tests)
curl -fsSL https://deno.land/install.sh | DENO_INSTALL=~/.local/deno sh
curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz \
  | tar -xJ -C ~/.local && mv ~/.local/node-v20.18.1-linux-x64 ~/.local/node-v20
```

`dev-env.sh` exports the `PATH` and `LD_LIBRARY_PATH` these need, so the
binaries are only on the path of scripts that ask for them. Run `psql` yourself
with `./scripts/dev-env.sh psql` rather than by absolute path — called directly
it fails with `libpq.so.5: cannot open shared object file`, because it needs
`LD_LIBRARY_PATH=~/.local/pgsql/root/usr/lib/x86_64-linux-gnu`.

Playwright's Chromium (`npx playwright install chromium`) lands in
`~/.cache/ms-playwright`; its three missing system libraries were unpacked the
same way into `~/.local/pw-libs`.

## Rehearsing the migration

`dev-seed.mjs` writes synthetic people. Real personnel records — names, DOB,
addresses, blood type, medical conditions, next-of-kin — are not copied onto a
dev machine to make a UI look populated.

To rehearse against real data, point `scripts/migrate-from-sheets.mjs` at a
**staging** database, never at this one and never at production:

```bash
APPS_SCRIPT_URL=… COUGAR_AUTH=… DATABASE_URL=… COUGAR_ENC_KEY=… \
  node scripts/migrate-from-sheets.mjs            # dry run: counts only
  #                                    --commit   # …then write
```

It is idempotent, so it can be re-run until the counts line up.

## Verifying a change

- `npm test` — units and static guards. No backend needed.
- `npm run test:live` — the full backend contract (`test/live/api-contract.test.js`)
  over HTTP against whatever `COUGAR_API` points at, default `127.0.0.1:8000`.
  It **skips itself** when nothing is listening, so it is safe in CI; a skip is
  not a pass, so bring the env up before trusting a green run.
- `npm run test:e2e` — the same contract from the client's side, in a real
  browser against `test/e2e/fake-backend.js`.
- `scripts/verify.sh` runs whichever of these apply to the diff and writes
  `EVIDENCE.md`.

The live test writes and deletes rows (`T_`-prefixed ids, 4D `9901`, and SOC as
its full-tab sandbox) and cleans up after itself. Point it at a dev database
only.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `psql: libpq.so.5: cannot open shared object file` | Called directly; use `./scripts/dev-env.sh psql`. |
| `API failed to start` | Read `~/.cougar-dev/edge.log`. Usually Postgres is down or `SUPABASE_DB_URL` is wrong. |
| Migrations do not re-apply | `up` skips them when the schema exists. Use `./scripts/dev-env.sh reset`, then `down && up` so the API reconnects. |
| `0002 … must run BEFORE the import` | Its own guard: it converts Roster columns to `bytea` and refuses to run over a populated roster. Reset first. |
| App still talks to Apps Script | The `cougar-api-url` key is per-browser-profile. Re-paste it, and check `STATE.apiUrl` in the console. |
| Port already in use | `./scripts/dev-env.sh status`, then `down`. |

## Removing it

```bash
./scripts/dev-env.sh down
rm -rf ~/.local/pgsql ~/.local/deno ~/.local/node-v20 ~/.local/pw-libs ~/.cougar-dev
```
