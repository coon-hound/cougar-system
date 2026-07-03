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
const sets = Object.entries(seed)
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
