#!/usr/bin/env bash
# ============================================================================
# Local test environment: real Postgres + the real Edge Function + the real
# frontend. No Docker, no Supabase account, no cloud, no production data.
#
#   ./scripts/dev-env.sh up       start everything (creates the DB on first run)
#   ./scripts/dev-env.sh down     stop everything
#   ./scripts/dev-env.sh reset    wipe the database and re-apply the migrations
#   ./scripts/dev-env.sh status   what is running
#   ./scripts/dev-env.sh psql     open a SQL shell on the dev database
#   ./scripts/dev-env.sh logs     tail the Edge Function log
#
# Everything lives under ~/.local (removable with: rm -rf ~/.local/pgsql
# ~/.local/deno ~/.local/node-v20 ~/.local/pw-libs) and ~/.cougar-dev.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$HOME/.cougar-dev"; mkdir -p "$RUN"

PG_HOME="$HOME/.local/pgsql"
PG_BIN="$PG_HOME/root/usr/lib/postgresql/16/bin"
PGDATA="$PG_HOME/data"
PGPORT=55432
DB=cougar_dev
DBUSER=cougar

API_PORT=8000
WEB_PORT=5600

export LD_LIBRARY_PATH="$PG_HOME/root/usr/lib/x86_64-linux-gnu:${LD_LIBRARY_PATH:-}"
export PATH="$HOME/.local/deno/bin:$HOME/.local/node-v20/bin:$PATH"

# Dev-only secrets. NOT the values any real deployment should ever use.
export SUPABASE_DB_URL="postgres://$DBUSER@127.0.0.1:$PGPORT/$DB"
export COUGAR_ENC_KEY="local-dev-key"
export APPS_SCRIPT_URL="${APPS_SCRIPT_URL:-}"

have() { command -v "$1" >/dev/null 2>&1; }
psql_() { "$PG_BIN/psql" -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" -d "$DB" "$@"; }
port_pid() { ss -lptn "sport = :$1" 2>/dev/null | grep -oP 'pid=\K[0-9]+' | head -1; }

require_deps() {
  local missing=0
  [ -x "$PG_BIN/postgres" ] || { echo "  missing: Postgres at $PG_BIN"; missing=1; }
  have deno  || { echo "  missing: deno (expected ~/.local/deno/bin/deno)"; missing=1; }
  have python3 || { echo "  missing: python3 (serves the frontend)"; missing=1; }
  if [ "$missing" = 1 ]; then
    echo
    echo "See DEV-ENV.md for how these were installed (all no-sudo, under ~/.local)."
    exit 1
  fi
}

pg_up() {
  if "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1; then return; fi
  if [ ! -d "$PGDATA" ]; then
    echo "  initialising cluster ..."
    "$PG_BIN/initdb" -D "$PGDATA" -U "$DBUSER" --auth=trust -E UTF8 >/dev/null
  fi
  "$PG_BIN/pg_ctl" -D "$PGDATA" \
    -o "-p $PGPORT -k $PG_HOME -c listen_addresses=127.0.0.1" \
    -l "$RUN/postgres.log" start >/dev/null
  for _ in $(seq 1 20); do
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" >/dev/null 2>&1 && break; sleep 0.5
  done
  "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" "$DB" 2>/dev/null || true
}

migrate() {
  # Re-applying 0002 over a populated roster is refused by its own guard, so
  # only run the migrations when the schema is not there yet.
  if psql_ -qAt -c "select to_regclass('public.roster')" 2>/dev/null | grep -q roster; then
    echo "  schema already present (use 'reset' to rebuild)"
    return
  fi
  for f in "$ROOT"/supabase/migrations/*.sql; do
    echo "  applying $(basename "$f") ..."
    psql_ -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
  done
}

api_up() {
  if [ -n "$(port_pid $API_PORT)" ]; then echo "  api already on :$API_PORT"; return; fi
  # The trailing redirections belong to the SUBSHELL, not the daemon: without
  # them the backgrounded child inherits this script's stdout, so `dev-env.sh up
  # | tail` (or any pipe, including the one verify.sh runs under) never sees EOF
  # and hangs forever after the work is done.
  ( cd "$ROOT" && setsid deno run -A --node-modules-dir=auto \
      supabase/functions/api/index.ts > "$RUN/edge.log" 2>&1 < /dev/null & ) \
    > /dev/null 2>&1 < /dev/null
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:$API_PORT/?action=ping" >/dev/null 2>&1 && return; sleep 0.5
  done
  echo "  API failed to start — see $RUN/edge.log"; tail -5 "$RUN/edge.log"; exit 1
}

web_up() {
  if [ -n "$(port_pid $WEB_PORT)" ]; then echo "  web already on :$WEB_PORT"; return; fi
  ( cd "$ROOT" && setsid python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 \
      > "$RUN/web.log" 2>&1 < /dev/null & ) \
    > /dev/null 2>&1 < /dev/null
  sleep 1
}

case "${1:-up}" in
  up)
    require_deps
    echo "Postgres ..."; pg_up
    echo "Migrations ..."; migrate
    echo "Edge Function ..."; api_up
    echo "Frontend ..."; web_up
    TOKEN=$(psql_ -qAt -c "select token from auth_tokens where revoked_at is null and expires_at > now() limit 1")
    if [ -z "$TOKEN" ]; then
      TOKEN="dev-token"
      psql_ -qAt -c "insert into auth_tokens (token, person, device_label) values ('$TOKEN','DEV','laptop') on conflict do nothing" >/dev/null
    fi
    cat <<EOF

  Ready.

    App        http://127.0.0.1:$WEB_PORT/index.html
    API        http://127.0.0.1:$API_PORT/
    Postgres   $SUPABASE_DB_URL

  Point the app at the local backend — paste into the browser console once,
  then reload. Both keys are read at startup (js/state.js):

    localStorage.setItem("cougar-api-url", "http://127.0.0.1:$API_PORT/");
    localStorage.setItem("cougar-auth", "$TOKEN");

  Seed some data to click around:   node scripts/dev-seed.mjs
  Check the backend contract:       npm run test:live
  Back to production:               localStorage.removeItem("cougar-api-url")

EOF
    ;;
  down)
    for p in $API_PORT $WEB_PORT; do
      pid=$(port_pid $p); [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "stopped :$p"
    done
    "$PG_BIN/pg_ctl" -D "$PGDATA" stop -m fast >/dev/null 2>&1 && echo "stopped postgres" || true
    ;;
  reset)
    require_deps; pg_up
    echo "Dropping and recreating $DB ..."
    "$PG_BIN/dropdb" -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" --if-exists "$DB"
    "$PG_BIN/createdb" -h 127.0.0.1 -p "$PGPORT" -U "$DBUSER" "$DB"
    migrate
    echo "Done. Restart the API so it reconnects:  $0 down && $0 up"
    ;;
  status)
    "$PG_BIN/pg_isready" -h 127.0.0.1 -p "$PGPORT" 2>/dev/null || echo "postgres: down"
    for p in $API_PORT $WEB_PORT; do
      pid=$(port_pid $p)
      echo "port $p: ${pid:+up (pid $pid)}${pid:-down}"
    done
    ;;
  psql)  shift; psql_ "$@" ;;
  logs)  tail -f "$RUN/edge.log" ;;
  *) echo "usage: $0 {up|down|reset|status|psql|logs}"; exit 1 ;;
esac
