# Evidence — training-programs-ui

_Base: `chore/e2e-pipeline` (= master + pipeline scaffolding)._

## What & why
Completes the Training Programs UI: a topbar program filter (`#filter-program`), program badges + a Program column in the attendance and conduct-detail tables, program-scoped participant counts, and a program→platoon assignment card on the Conducts tab. The `program*` helpers it relies on (`progKey`, `programBadge`, `recruitsInProgram`, `STATE.programs`, …) are already on master; this wires up the UI. Uniform cache-buster bumped to `?v=107`.

## Changed files
```
 index.html   | 21 +++++++++---------
 js/main.js   | 18 +++++++++++++++
 js/render.js | 72 ++++++++++++++++++++++++++++++++++++++++-------
 test/e2e/training-programs.spec.js | (new feature spec)
```

## node test/run.js — units + static guards
```
40 passed, 0 failed
```
Includes the static guards that bite on this change: uniform `?v=` (all tags at v107) and parse-all-scripts-together (no duplicate top-level declarations).

## Playwright — real-browser e2e
- Spec authored: `test/e2e/training-programs.spec.js` (2 tests: filter narrows the attendance table + badges; Conducts assignment card renders). Seeds demo data, no network.
- Syntax-validated locally (`node --check` on the spec + support).
- **Browser run deferred to CI.** The ~171 MB Chromium binary would not finish downloading in the authoring sandbox (CDN stalled at 10–30% across 5 retries). The GitHub Actions `e2e` job installs Chromium and runs this spec; it is the enforcing gate. To run locally: `npm install && npx playwright install chromium && npm run test:e2e`.

## Manual test in the website
```
bash scripts/preview.sh training-programs-ui 8080   # open the printed seeded URL
```
Then: Attendance tab shows PTP/BMT/Combined badges → pick PTP in the topbar "programs" filter → table narrows to the PTP session. Conducts tab → Training Programs card → toggle a platoon checkbox.

## Result: ✅ node gate PASS · ⏳ browser gate runs in CI
Deploy: frontend — merge + `git push` (GitHub Pages). `?v=107` already bumped.
