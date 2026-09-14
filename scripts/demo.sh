#!/usr/bin/env bash
# ============================================================================
# One command to click around the REAL app on the REAL new backend.
#
#   ./scripts/demo.sh            start (or reuse) the demo, reseed, print the URL
#   ./scripts/demo.sh --fresh    wipe the database first and rebuild from scratch
#   ./scripts/demo.sh --stop     stop everything
#
# This is the backend-connected sibling of scripts/preview.sh. preview.sh runs
# the app OFFLINE out of localStorage, which is the right way to look at a
# frontend change; this one runs it against Postgres and the Edge Function, so
# every save round-trips through the thing the migration actually replaced —
# revisions, conflicts, batching, encryption and all.
#
# Everything is synthetic and local. No production data, no cloud, no account.
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DEV="$ROOT/scripts/dev-env.sh"
WEB_PORT=5600
API_URL="http://127.0.0.1:8000/"

# The app shows its "What's New" panel once per release (js/patchnotes.js:172).
# A demo should open on the dashboard, not a changelog, so stamp the CURRENT
# version as already seen — read from source, so this neither goes stale nor
# suppresses genuinely new notes later. Same trick as the e2e fixture.
APP_VERSION="$(sed -n 's/^const APP_VERSION = \([0-9]*\);.*/\1/p' js/patchnotes.js)"

case "${1:-}" in
  --stop) exec "$DEV" down ;;
  --fresh) FRESH=1 ;;
  "") FRESH=0 ;;
  *) echo "usage: $0 [--fresh|--stop]"; exit 1 ;;
esac

if [ "$FRESH" = 1 ]; then
  echo "Rebuilding the database ..."
  "$DEV" down >/dev/null 2>&1 || true
  # The API holds a connection pool, so it has to come down before the database
  # is dropped and back up afterwards to reconnect.
  "$DEV" reset >/dev/null
fi

echo "Starting Postgres, the Edge Function and the web server ..."
if ! up_out="$("$DEV" up 2>&1)"; then
  echo "$up_out"
  exit 1
fi

# Whatever token the environment issued — dev-env.sh mints 'dev-token' on a
# fresh database. Read it rather than assuming, so a re-issued token still works.
TOKEN="$("$DEV" psql -qAt -c \
  "select token from auth_tokens where revoked_at is null and expires_at > now() limit 1")"
if [ -z "$TOKEN" ]; then echo "No usable auth token in the database."; exit 1; fi

echo "Seeding synthetic data ..."
node scripts/dev-seed.mjs --token "$TOKEN"

# The entry page. It parks the two keys the app reads at startup
# (js/state.js:15,21) and clears any cached state from an earlier session, so
# the app boots with an empty cache and pulls everything from Postgres — which
# is the path worth demonstrating. Git-ignored; regenerated on every run.
cat > __demo.html <<HTML
<!doctype html><meta charset="utf-8"><title>starting the demo…</title>
<body style="font:14px system-ui;padding:2rem">Pointing the app at the local backend…
<script>
  // Cached app state from a previous session (or from scripts/preview.sh,
  // which seeds these same keys for its OFFLINE demo) would render first and
  // make the launch pull look like a no-op. Start clean.
  for (const k of ["cougar-data-v3", "cougar-data-v2", "cougar-data", "cougar-filter",
                   "cougar-programs", "cougar-combined-groups", "cougar-dirty-tabs",
                   "cougar-dirty-ops-v1", "cougar-parade-snapshots",
                   "cougar-custom-statuses", "cougar-fitness-sent"]) {
    localStorage.removeItem(k);
  }
  localStorage.setItem("cougar-seen-version", "$APP_VERSION");
  localStorage.setItem("cougar-api-url", "$API_URL");
  localStorage.setItem("cougar-auth", "$TOKEN");
  location.replace("index.html");
</script>
HTML

cat <<EOF

  Demo ready.

    Open   http://127.0.0.1:$WEB_PORT/__demo.html

  It points this browser at the local backend, then opens the app. Every edit
  you make is written to Postgres through the Edge Function — open a second tab
  to watch changes sync between them.

  Things worth trying
    • Dashboard    today's parade state: who is out on MC, on leave, booked out
    • Book Out     dashboard → "+ Book Out" — writes, then watch the second tab
    • Roster       tap a recruit for the profile card (DOB / NOK are encrypted
                   at rest and decrypted by the API on read)
    • Sync & I/O   revisions, dirty tabs, "Re-push all"
    • IPPT         three attempts each, so progression and compare have a series

  Watch it work      ./scripts/dev-env.sh logs
  Query the data     ./scripts/dev-env.sh psql -c "select count(*) from roster"
  Start over         ./scripts/demo.sh --fresh
  Stop               ./scripts/demo.sh --stop
  Back to production localStorage.removeItem("cougar-api-url")   (in the console)

EOF
