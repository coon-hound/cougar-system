# Local dev environment

A real Postgres, the real Edge Function and the real frontend, running on this
machine. No Docker, no `sudo`, no Supabase account, no cloud, and no production
data — so the Sheets → Postgres migration can be rehearsed, broken and re-run as
often as you like before anything is cut over.

```
./scripts/demo.sh             # everything up, seeded, with a URL to click
./scripts/demo.sh --fresh     # …from an empty database
./scripts/demo.sh --stop      # stop everything
```

That is the short way in: it starts the pieces below, seeds synthetic data, and
prints a link that points the browser at the local backend for you. The pieces
are also drivable one at a time:

```
./scripts/dev-env.sh up       # start everything (creates the DB on first run)
node scripts/dev-seed.mjs     # synthetic people to click around
npm run test:live             # the backend contract, against the real thing
./scripts/dev-env.sh down     # stop everything
```

`up` prints the two `localStorage` lines that point the app at the local
backend. Paste them into the browser console once and reload.

### Two demos, on purpose

| | `scripts/preview.sh` | `scripts/demo.sh` |
|---|---|---|
| Data from | `localStorage`, seeded from a fixture | Postgres, via the Edge Function |
| Backend | none — the app never calls out | the real one |
| Good for | looking at a frontend change | anything that saves, syncs or conflicts |

The offline one stays the right tool for a UI change: it is instant and cannot
be affected by backend state. Use the connected one when the behaviour you care
about involves a round trip.

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

## Cutting over to Supabase

**Where it stands (13 Sep 2026):** schema, Edge Function, importer, backup and
verification tooling are built and gated on `feat/supabase-backend`. Nothing is
deployed and no Supabase project exists yet — the live Sheet is still
production. Steps 1-7 below have been exercised against the local backend only;
the Supabase CLI steps (3) have not yet been run against a real project.

`dev-seed.mjs` writes synthetic people. Real personnel records — names, DOB,
addresses, blood type, medical conditions, next-of-kin — are not copied onto a
dev machine to make a UI look populated. The cutover below reads them straight
from the live Sheet into the backup directory and the Supabase project, and
nowhere else.

**Secrets go in files outside the repo** (it is public), created on whichever
machine does the cutover:

```
~/.cougar-token         a live Sheets auth token — on any signed-in device,
                        DevTools console: localStorage.getItem("cougar-auth")
~/.cougar-migrate.env   DATABASE_URL=<Supabase → Database → Session pooler URI>
                        COUGAR_ENC_KEY=<generate once: openssl rand -base64 32>
```

`chmod 600` both. Keep a second copy of `COUGAR_ENC_KEY` in a password manager:
lose it and the eight encrypted roster columns are unrecoverable.

Each step gates the next:

```bash
set -a; . ~/.cougar-migrate.env; set +a
export COUGAR_AUTH="$(cat ~/.cougar-token)"
export APPS_SCRIPT_URL="$(sed -n 's/^const APPS_SCRIPT_URL = "\(.*\)"/\1/p' js/state.js)"

# 1. Back up every tab of the live Sheet (to ~/cougar-backups/<stamp>), read it back
node scripts/backup-sheets.mjs
node scripts/backup-sheets.mjs --verify ~/cougar-backups/<stamp>

# 2. Schema (psql from the toolchain above, with its LD_LIBRARY_PATH)
psql "$DATABASE_URL" -f supabase/migrations/0001_init.sql
psql "$DATABASE_URL" -f supabase/migrations/0002_security.sql

# 3. Edge Function
npx supabase login
npx supabase secrets set COUGAR_ENC_KEY="$COUGAR_ENC_KEY" --project-ref <ref>
npx supabase functions deploy api --project-ref <ref> --no-verify-jwt

# 4. Dry run — runs the real transform against the real schema, writes nothing
node scripts/migrate-from-sheets.mjs

# 5. Import (one transaction; revisions reset to 1)
node scripts/migrate-from-sheets.mjs --commit

# 6. A token on the new backend
psql "$DATABASE_URL" -qAt -c "insert into auth_tokens (token, person, device_label)
  values (gen_random_uuid()::text, '<who>', '<device>') returning token"

# 7. The acceptance gate: new backend, through its own API, against the backup
NEW_API_URL=https://<ref>.supabase.co/functions/v1/api NEW_AUTH=<token> \
  node scripts/verify-migration.mjs ~/cougar-backups/<stamp>
```

- **`--no-verify-jwt` is required.** The app authenticates with its own tokens
  (`auth_tokens`), not Supabase JWTs, so with verification on the gateway
  rejects every request before the function sees it. `SUPABASE_DB_URL` is
  supplied to the function by Supabase; `COUGAR_ENC_KEY` is not.
- **Read the dry run's audit before step 5:** `NO SUCH TABLE` means step 2
  did not apply; `COLUMNS NOT IN THE SCHEMA` is the live Sheet having grown a
  field since `0001_init.sql`; `ROWS WITH NO USABLE id` are skipped, not
  imported. The import is idempotent, so fix and re-run.
- **Step 7 must say "The new backend serves what the old one served."** A
  `FAIL` means do not cut over; `--show-values` shows the actual differences.
- **Then one device:** set `cougar-api-url` to the function URL and `cougar-auth`
  to the step 6 token in `localStorage`, reload, use it for real work.
  `localStorage.removeItem("cougar-api-url")` backs out to the Sheet.
- **After that:** rewire the Telegram bot to the new API, then drop the
  Gmail / Claude-vision passthrough.

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

The live test writes and deletes rows (`T_`-prefixed ids, 4D `9901`) and cleans
up after itself — but its full-tab suites **replace SOC and MSK wholesale**, and
MSK rows have no `id`, so nothing tombstones them. It snapshots and restores
both tabs, which covers a populated dev database, not a crash midway. It
refuses any non-localhost `COUGAR_API` unless `COUGAR_LIVE_TEST_SCRATCH=1`.
**Never point it at the Supabase project once it holds real data** — use
`scripts/verify-migration.mjs`, which only reads.

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
