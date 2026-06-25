# Sync tests

Zero-dependency tests for the multi-device sync layer. Run with:

```
npm test          # or: node test/run.js
```

## What runs

- **`backend.test.js`** — the REAL `apps-script-Code.gs` functions (`getRev`/`bumpRev`/`withRevLock`/`readTab`/`upsertRow`/…) against in-memory mocks of Google services (`test/mocks/google.js`). Covers the OCC enforce matrix, append-never-conflicts, `ensureColumnsForKeys`, and the `readTab` "skip the second display read" optimization.
- **`sync.test.js`** — the centerpiece. `test/harness.js` loads the REAL backend once and spins up multiple "tabs" (each the REAL `js/state.js` + `js/api.js` + `js/sync.js`), wired through a mock `fetch` that routes into the real `doGet`/`doPost`. Scenarios: stale-edit auto-merge, stale-replace rejection, append, auto-refresh partial pull, dirty-tab protection, manual-edit (`onEdit`) propagation, bot-write rev bump (leak regression), queue serialization, incremental vs full launch.
- **`static.test.js`** — load-time guards: all `js/*.js` concatenated and compiled as one program (catches duplicate top-level `const`/`let` across files — the bug that blanked the dashboard), `?v=` cache-version consistency, and a heuristic scan that every direct tracked-tab write is followed by a `bumpRev`.

## Limitations (intentional)

- **No true wall-clock parallelism.** Apps Script serializes each request; the harness backend runs synchronously per call, so the lock is a no-op. We exercise the OCC *logic* by interleaving client calls deterministically — every conflict path is covered, but not real thread races.
- **No real DOM/pixels/timers.** The harness stubs `document` and timers and asserts *which* handler/banner fires and *what* `STATE` results — not rendering or real focus/visibility events. (That would be a Playwright layer; deferred.)

## Prove the suite bites

- Remove the `bumpRev("Medical")` after the bot append in `apps-script-Code.gs` → `sync.test.js` "bot … propagates" and `static.test.js` rev-bump scan go red.
- Re-introduce a duplicate top-level `const` in any `js/*.js` → `static.test.js` "all scripts parse together" goes red.
