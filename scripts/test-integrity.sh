#!/usr/bin/env bash
# Real browser + real Edge Function + an isolated synthetic Postgres cluster.
# Never adopts an existing database or API. Everything is under a private tmpdir.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.local/node-v20/bin:$HOME/.local/deno/bin:$PATH"
if [ "$(uname -s)" = Darwin ]; then
  PG_BIN="$(brew --prefix)/opt/postgresql@16/bin"
else
  PG_BIN="${PG_BIN:-$HOME/.local/pgsql/root/usr/lib/postgresql/16/bin}"
  [ -d "$PG_BIN" ] || PG_BIN=/usr/lib/postgresql/16/bin
  export LD_LIBRARY_PATH="$HOME/.local/pgsql/root/usr/lib/x86_64-linux-gnu:$HOME/.local/pw-libs/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi
export PATH="$PG_BIN:$PATH"
RUN="$(mktemp -d "${TMPDIR:-/tmp}/cougar-integrity.XXXXXX")"
API_PID=""
cleanup() {
  [ -z "$API_PID" ] || kill "$API_PID" 2>/dev/null || true
  pg_ctl -D "$RUN/pg" stop -m fast >/dev/null 2>&1 || true
  echo "Synthetic test logs: $RUN"
}
trap cleanup EXIT
export COUGAR_INTEGRITY_DB="postgres://cougar@127.0.0.1:58432/cougar_integrity"
export COUGAR_INTEGRITY_API="http://127.0.0.1:58001/"
export SUPABASE_DB_URL="$COUGAR_INTEGRITY_DB"
export COUGAR_ENC_KEY=local-dev-key
export APPS_SCRIPT_URL=""
export PORT=58001
export API_HOST=127.0.0.1
initdb -D "$RUN/pg" -U cougar --auth=trust -E UTF8 > "$RUN/init.log"
pg_ctl -D "$RUN/pg" -o "-p 58432 -k $RUN -c listen_addresses=127.0.0.1" -l "$RUN/postgres.log" start > "$RUN/start.log"
createdb -h 127.0.0.1 -p 58432 -U cougar cougar_integrity
for file in supabase/migrations/*.sql; do
  psql "$COUGAR_INTEGRITY_DB" -v ON_ERROR_STOP=1 -f "$file" >> "$RUN/schema.log" 2>&1
done
deno run --allow-net --allow-env --node-modules-dir=none supabase/functions/api/index.ts > "$RUN/api.log" 2>&1 &
API_PID=$!
node --input-type=module <<'JS'
const url = process.env.COUGAR_INTEGRITY_API;
let ready = false;
for (let i = 0; i < 100; i++) {
  try {
    const res = await fetch(url + '?action=ping');
    if ((await res.json()).build === '2026-10-14-seating-1') { ready = true; break; }
  } catch {}
  await new Promise(r => setTimeout(r, 100));
}
if (!ready) throw new Error('The isolated Edge Function did not start; a skip is not a pass');
JS
psql "$COUGAR_INTEGRITY_DB" -v ON_ERROR_STOP=1 -c "insert into auth_tokens(token,person,can_invite) values ('dev-token','SYNTHETIC TEST ADMIN',true)" >> "$RUN/schema.log"
# Keep the existing real HTTP contract working under the protected protocol.
COUGAR_API="$COUGAR_INTEGRITY_API" node test/live/api-contract.test.js > "$RUN/contract.log" 2>&1 || { cat "$RUN/contract.log"; exit 1; }
npx playwright test --config playwright.integrity.config.js "$@"
