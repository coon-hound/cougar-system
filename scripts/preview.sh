#!/usr/bin/env bash
# Serve the CURRENT worktree locally with the demo data pre-seeded, so you can
# click through the feature in a real browser before merging. Each feature can
# run on its own port, so several previews coexist.
#
#   scripts/preview.sh [slug] [port]        (port defaults to 8080)
#
# Open the printed "Preview (seeded)" URL. It writes the demo fixture into
# localStorage then redirects to index.html — the app renders straight from that
# cache with no backend (STATE.authToken is empty). All seed logic lives in this
# dev script + test/e2e/fixtures, never in js/*, so production stays untouched.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"
slug="${1:-$(git rev-parse --abbrev-ref HEAD | sed 's#.*/##')}"
port="${2:-8080}"

# Generate the git-ignored seeding page from the shared fixture.
node -e '
const fs = require("fs");
const seed = require("./test/e2e/fixtures/demo-seed.json");

// The data cache key is VERSIONED and gets bumped at every change of intake,
// and every older key is on STORAGE_KEY_LEGACY - which loadLocal() does not
// merely ignore, it DELETES. So seeding the fixture under its own key handed
// the app a cache it wiped on the way in, and the preview opened on an empty
// roster with nothing to say why. test/e2e/support.js already re-keys for
// exactly this reason; this is the same fix for the manual-test step.
const src = fs.readFileSync("./js/state.js", "utf8");
const m = src.match(/const STORAGE_KEY\s*=\s*"([^"]+)"/);
if (!m) { console.error("could not read STORAGE_KEY out of js/state.js"); process.exit(1); }
const DATA_KEY = m[1];

const sets = Object.entries(seed)
  .map(([k, v]) => [/^cougar-data(-v\d+)?$/.test(k) ? DATA_KEY : k, v])
  .map(([k, v]) => `  localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(JSON.stringify(v))});`)
  .join("\n");
fs.writeFileSync("__preview.html",
`<!doctype html><meta charset="utf-8"><title>seeding demo…</title>
<script>
${sets}
  location.replace("index.html");
</script>
Seeding demo data, redirecting…`);
'

echo
echo "  Feature   : ${slug}"
echo "  Preview   : http://127.0.0.1:${port}/__preview.html   (seeds demo data, then opens the app)"
echo "  App direct: http://127.0.0.1:${port}/index.html        (uses whatever is already in this browser)"
echo "  Ctrl-C to stop."
echo
exec python3 -m http.server "$port"
