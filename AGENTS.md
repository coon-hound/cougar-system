# AGENTS.md — Cougar System

Guidance for agents working in this repo. The big active workstream is the **Telegram report-sick (RSO) bot** built inside `apps-script-Code.gs`. Read the relevant section before touching that code.

## General working notes (this user)
General cross-project conventions (em dash, commit co-author, quality bar, reproduce-bugs-E2E-first) live in the global `~/.claude/CLAUDE.md` - not repeated here. Project-specific only:
- Iterating on the bot is fast: the user re-pastes the whole `apps-script-Code.gs` into the Apps Script editor and clicks **Save**. Always syntax-check a copy before handing back:
  `cp apps-script-Code.gs /tmp/x.js && node --check /tmp/x.js`

---

# Cougar Telegram Report-Sick (RSO) Bot — handoff notes

A Telegram chatbot that guides 40 SAR "Cougar Company" recruits through reporting sick correctly.
Built entirely inside the existing Google Apps Script backend (`apps-script-Code.gs`) — no separate server, no frontend change.
Origin: a real incident where a late enlistee + others applied for medical leave wrongly, didn't inform their Section Commander (SC), missed book-in cut-offs, and got the company flagged by HHQ.

## Where the code lives
All bot code is a delimited "TELEGRAM BOT" section in `apps-script-Code.gs` (functions prefixed `tg*`). Nothing else in the repo was changed for the bot. The frontend (`js/*.js`) is untouched.

## The single most important lesson: use POLLING, not webhooks
- Apps Script web apps answer via a **302 redirect**. Telegram's `setWebhook` **rejects the 302** — the bot appears to receive nothing, or Telegram retries the same update forever (causing the welcome message to loop, then go silent once dedup kicks in).
- Fix: **long-poll `getUpdates`** on a 1-minute time-based trigger.
  - `startTelegramPolling()` deletes the webhook (`drop_pending_updates=true`) and installs `ScriptApp.newTrigger("tgPoll").timeBased().everyMinutes(1)`.
  - `tgPoll()` takes a `LockService` lock (`tryLock(500)` — bail if another poller holds it), then loops for ~5 min calling `getUpdates?timeout=50&offset=<TG_OFFSET>`, dispatches each update, and advances `TG_OFFSET = update_id + 1`.
  - **Advancing the offset acks the update server-side**, so Telegram never resends it — no manual dedup, no 302 problem.
  - Per-update handling is wrapped in try/catch and the offset advances regardless, so one bad update can't wedge the loop.
- **Polling runs whatever code is currently SAVED — no redeploy needed.** After editing, the user just re-pastes into the editor and clicks Save. (Only webhook mode needed a new deployment version.)
- Check status with `tgPollingStatus()` (logs ON/OFF by counting `tgPoll` triggers, prints `TG_OFFSET`, and prints `getWebhookInfo` whose `url` must be EMPTY when polling). Or look at Executions (tgPoll ~once/min) / Triggers page.

## Other Apps Script gotchas (all cost real debugging time)
- **`/dev` vs `/exec` URL:** the test `/dev` deployment and the published `/exec` deployment have DIFFERENT script IDs. Setting a webhook to `/dev` silently fails. Irrelevant now (polling), but pin the real `/exec` URL if ever going back to webhooks.
- **OAuth scopes for triggers:** `ScriptApp.getProjectTriggers()` throws "permissions not sufficient... script.scriptapp" unless the scopes are declared in `appsscript.json` (`oauthScopes`: spreadsheets, script.external_request, script.scriptapp, drive, script.send_mail, userinfo.email). After adding them, re-run any function once to trigger the consent screen.
- **`tgApi()` mutes HTTP exceptions and returns parsed JSON (or null on throw); never lets an API error abort a handler.** `tgSavePhoto` and sheet writes are wrapped in try/catch for the same reason — a slow/failed Drive save or group post must never stop the recruit from getting a reply.

## Idempotency — recruits double-tap
Processing can be slow (Drive, sheet, Telegram calls), so recruits tap the same inline button multiple times, firing duplicate requests. Defences, applied to EVERY callback:
1. **Step-gating:** each callback checks `state.step` and returns early if it's not the expected step (e.g. `sc:informed` only runs at `rs_sc`; `rs:submitmc` only at `post_request`). A stale/duplicate tap is a no-op.
2. **Claim the step immediately:** the handler sets the next step BEFORE doing slow work, so a second tap that arrives mid-processing fails the step check.
3. **`tgStripKeyboard(cb)`** removes the inline keyboard (via `editMessageReplyMarkup`) once a button is used, so old messages' buttons can't be tapped again.
4. On photo upload, the step flips to `mc_saving` immediately and the recruit gets an instant "📷 Got your MC — saving…" ack before the slow Drive/group work.

## Conversation state machine
Per-chat state is JSON in ScriptProperties under `tg:state:<chatId>` (`{step, ...draft}`), cleared on completion/cancel. Identity + config live in Sheet tabs. `/cancel` and the `rs:cancel` button (present on every step) clear state and return to the menu. `tgResetBot()` clears all `tg:state:` keys + dedup marker if things wedge.

## Sheet tabs created by `setupBotTabs()`
- **`TgUsers`**: `id`(=chatId, upsert key), chatId, userId, username, d4, name, role, rank, sectionsOwned, registeredAt. `plt`/`sect` are NOT stored — derived at read time from the 4D's first two digits in `tgFindUser`.
- **`ReportSick`**: id, d4, name, plt, sect, context, reason, clinic, reportedAt, cutoffAt, bookInAt, status, startDate, endDate, mcUrl, state(Requested/MC-Submitted/NoStatus), notifiedSC.
- **`Config`** (COS edits this single row): botGroupChatId, nextBookInDate, nextBookInTime, outOfCamp(TRUE/FALSE), cutoffHours(default 4), rsoFormUrl.
- On MC submit, the bot ALSO appends a clean row to the existing **`Medical`** tab so it flows into the dashboard + parade state with zero frontend change. `readAllTabs` ignores the new tabs (isolated).

## Key design decisions (confirmed with the user)
- **Runtime inside Apps Script** (serverless, free, reuses sheet helpers + auth).
- **Identity = 4D + name verified against the `Roster` tab.** Role comes from `Roster.role` (literal `"Commander"` else defaults Recruit). Section commanders register exactly like recruits; the bot detects Commander role and then asks which section(s) they own (`P1S3`, comma-separated for multiple).
- **Book-in time is set by the COS in the `Config` tab.** Bot computes `cutoff = bookIn − cutoffHours` (default 4h).
- **Commander notification: post to a commanders' Telegram GROUP and @-mention the SC(s)** via Telegram `text_mention` entities (offset in UTF-16 code units). This pings even commanders with no public @username, but REQUIRES the SC's `userId`, captured when they register. Falls back to plain text if the SC isn't on the bot. The bot must be a member of that group; `Config.botGroupChatId` holds its id (a `/here` command in-group prints the id).
- **A section can have MORE THAN ONE commander.** `tgFindSectionCmds` returns ALL commanders owning the section; `tgGroupNotify` accepts one SC or an array and @-mentions every one.

## Anti-impersonation (only credential is 4D+name, both semi-public)
- **Double-confirm at registration:** after 4D+name match, the bot shows "you're registering as REC X (Cxxxx), P# S# — Is this you?" with a confirm button. Attestation moment; catches typos/wrong entries before saving.
- **One 4D ↔ one Telegram account:** `tg4dClaimedByOther(d4, chatId)` refuses to register a 4D already linked to a DIFFERENT chat. Reclaiming requires a commander to delete that row in `TgUsers` — deliberate + auditable. A recruit cannot silently take over a peer's slot.
- `/whoami` shows current identity; `/register` re-runs the guarded flow (can only land on an unclaimed 4D).

## Cut-off semantics (subtle — the user corrected this)
The 4h-before-book-in cut-off is the **deadline by which the status/MC must ALREADY be SUBMITTED**, not merely when they may start. All messaging frames it that way ("your status/MC must be SUBMITTED by 0745 (4h before book-in) — see the doctor and send it here before then; start now"). A recruit is only BLOCKED from the outside report-sick flow when BOTH: `outOfCamp=TRUE` AND `now > cutoff`. In camp, never time-blocked (no external cut-off).

## MC submission flow (evolved — recruits no longer self-declare status)
- The recruit taps **Submit MC** → uploads a PHOTO of the slip. **No self-entered status or duration** (removed on purpose — recruits self-declaring wrong medical statuses was part of the original problem).
- The MC image is shown INLINE in the commanders' group via `sendPhoto` with the Telegram `file_id` (re-using the file_id the user uploaded — same bot can resend it; no Drive link in the caption). A Drive copy is still saved to `ReportSick.mcUrl`.
- The `Medical` row is written with **status/dates left BLANK for the COS to fill in from the image** — decision was "Log record, blanks for COS" (keeps it flowing to the dashboard while a human sets the authoritative status).
- **If the recruit got NO status, they must STILL tap Submit MC** — there's a "🚫 No status given (nothing to upload)" button on the photo screen (→ `NoStatus`). This is messaged explicitly in the post-request ack, because otherwise a no-status recruit has nothing to upload and gets stuck.

## Input hygiene
- Only the genuinely typed steps (`rs_reason`, `rs_clinic`, `reg_*`) read free text; they reject empty/non-text (sticker/photo) input and re-ask. Prompts use "✍️ Type … below (e.g. …)" to make typing obvious.
- Typing text during a button-only step never gets captured into the wrong field — the `default` switch branch is step-aware and nudges the user back to the correct button instead of dumping them to the generic menu.

## User-facing tone expectations
- Show the menu (Report Sick / RSO Procedure) after every completed interaction; stale buttons must be dead.
- The "inform your SC" gate is a single hard step with aggressive, unambiguous wording: recruits MUST personally WhatsApp their SC first; the bot notifying is NOT a substitute. The SC is pinged regardless (one button, no "ping him for me" alternative).

---

# Core system - lessons learned (frontend + sync + Sheets)

The main app: vanilla-JS SPA served from GitHub Pages (`js/*.js`, classic script tags), backed by the same `apps-script-Code.gs` web app reading/writing Google Sheets. Zero-dependency Node test harness in `test/` (run: `node test/run.js`).

## Deploy model - know which half you changed
- **Frontend** (`js/*.js`, `index.html`, `styles.css`): git push to GitHub Pages. Users forget to push - "works on my phone but not my laptop" = unpushed changes.
- **Backend** (`apps-script-Code.gs`): the web app endpoints need a redeploy (the bot's polling path only needs Save - see above). Always state which deploy a change needs.
- **Bump the `?v=NN` cache-buster in `index.html` on EVERY frontend change** - same version on every script tag AND styles.css. A mismatch ships partly-stale JS. A static test enforces uniformity.

## Frontend architecture rules
- Classic `<script>` tags share **one global lexical scope**. A duplicate top-level `const`/`let` across two files is a SyntaxError that kills the later file and blanks the whole page (happened: `STATE_TO_TAB` declared in both helpers.js and api.js -> empty dashboard in prod). A static test compiles all scripts concatenated in load order to catch this.
- File roles: `state.js` (STATE + normalizers + localStorage), `api.js` (backend calls), `helpers.js` (pure utils + shared computations), `render.js` (views/charts), `forms.js` (modals, parade state), `sync.js` (auto-refresh/push/conflict), `main.js` (boot + topbar filter), `ippt-scoring.js` (scoring tables).

## Google Sheets as a database - pitfalls
- **Sheets coerces strings on write.** `setValues` with `"12:30"` (a 2.4km run time) becomes a time/date serial, corrupting the value; the corruption then round-trips into the app and re-propagates on every push. **All data-row writes must go through `setValuesAsText()`** (sets `setNumberFormat("@")` before `setValues`). Header writes stay raw. A static test scans for raw `.setValues(<data payload>)` regressions. Fixing the write path does not un-corrupt existing cells - those need re-entry or a re-push from a device with good cached data.
- `writeTab` derives headers from `Object.keys(data[0])` - a stale first row missing new keys silently strips those columns from the entire pushed tab. Normalizers must guarantee every row carries the full schema.
- `ensureColumnsForKeys` auto-appends missing header columns on first write -> **frontend-only field additions need no redeploy and no manual sheet setup**.
- Read path: time-only Date cells (epoch year < 1900) need `getDisplayValues()` to preserve user format, but that is a second full sheet read - only fetch it when such cells actually exist.

## Sync design (many devices, one sheet) - do not regress these
- Per-tab revision counters (`rev:<Tab>` in ScriptProperties) + optimistic concurrency via `withRevLock(tab, baseRev, enforce, fn)`.
- **OCC enforce=true ONLY for full `write`/replace.** Row-scoped upsert/delete/append use enforce=false - they can't clobber other rows, and enforcing tab-level rev on them causes false conflicts when two devices edit different recruits.
- **Every direct backend write must `bumpRev(tab)`** - a missed bump means every client's `revCheck` silently misses the change (happened with the bot's Medical append). A static lint test scans for tracked-tab writes without a nearby bumpRev.
- **Data writes use the document lock** (`LockService.getDocumentLock()`), NOT the script lock - `tgPoll` holds the script lock for ~5 minutes and once made writes queue 21+ seconds.
- Conflict handling: bounded retry loop (6x), seeding `baseRev` from the conflict's returned `serverRev`. Single-retry against a moving target keeps failing.
- Auto-refresh: 20s `revCheck` poll + focus/visibility/online events + partial `pullTabs` of only changed tabs. Launch does revCheck + partial pull when baselined, full `readAll` otherwise.
- Sync status is the topbar pill (green/orange/red) - keep it loud, especially on mobile. Do NOT auto-pop a "Force resync" banner (explicit user preference); Force Resync stays a manual button in the Sync tab.

## Single source of truth for derived state
- If two views show the same fact, they must call the same function. The in/out-of-camp bug: dashboard and parade state computed "who's out" differently and never matched. Fix: `outOfCampMap(dateIso)` in helpers.js is THE definition (active MC/Warded + active leave + manual book-outs); dashboard, parade strength, and the OTHERS section all read it.
- Precedence when someone is out for multiple reasons: **medical > leave > manual book-out**.
- **Day-scoped flags beat timers for daily auto-reset:** booked-out = `outOfCamp && outSince === todayISO()`. Yesterday's book-out is simply ignored today - no cron, no midnight write storm, timezone-correct. Store the local day string (`todayISO()`), never a UTC timestamp, for SGT day-boundary logic.

## Movement board (where each in-camp body is right now)
- The Movement tab (`renderMovement`, render.js) partitions every recruit into exactly ONE location bucket so bucket counts sum to recruit strength. Built entirely on the two proven patterns above - no new tab, no backend redeploy.
- `movementBuckets(dateIso)` / `movementLocationOf(d4, dateIso, outMap?)` in helpers.js are THE definition; precedence **out-of-camp (read-only) > manual in-camp `location` (day-scoped) > `DEFAULT_LOCATION` ("Main Body")**. Out-of-camp bodies are bucketed by the SAME `outOfCampMap`, so the board can never disagree with the strength tiles. The dashboard widget (`renderDashMovement`) and the tab both read `movementBuckets`.
- Persistence: two Roster columns `location` + `locationSince` (day-scoped exactly like `outSince`, so everyone auto-returns to Main Body next day), written via per-row `autoSync("Roster", {type:"upsert",...})` - the `bookOutToggle` template. Auto-created server-side by `ensureColumnsForKeys`; defaulted in `normalizeRoster` so a full re-push doesn't strip them. `moveToLocation(d4s, location)` is the single mutation (optimistic local update, then N upserts).
- Location NAMES are a managed list (`STATE.locations`, `loadLocations`/`saveLocations` in state.js, own localStorage key `cougar-locations`, DEFAULT_LOCATION always index 0) - a named list, not free text, so a typo can't fork one place into two buckets. `openLocationsForm` renames (recruits follow) / removes (recruits return to Main Body). Commanders are excluded (same convention as strength/conduct).
- **UX model (redesigned - UX is #1 here, tuned for a spec updating the board in ~20s on a phone):** the primary move flow is ON-BOARD tap-to-move, NOT a modal. `MOVE_MODE` (module flag in render.js) turns recruit chips into tap-to-select and every location card + the sticky drop bar into drop targets - so you never scroll a 40-person checklist. After a drop the board STAYS in move mode (do several moves, tap Done to exit). Selection lives purely in the DOM (`.mv-chip.sel`), read on drop - so chip taps do NOT re-render (avoids render()'s scroll-to-top jump); `_mvScroll` restores scroll across the one re-render a drop causes.
- **Quick-pick is the fast path** (the thing specs actually do - move whole UNITS): a `.mv-quickpick` bar in move mode with one-tap TOGGLE buttons for `All / each platoon / each program / each group` (`mvUnitIds`/`mvQuickPick`/`mvQuickPickEl`). Selecting a unit picks its in-camp, in-scope members wherever they currently sit, so "P1 → Range" is 2 taps. Only units with in-camp members in scope are shown (no dead buttons). This restored + extended the platoon/program mass-select the user valued; groups (the `groups` roster field) ride the same mechanism. Per-card `mvSelectAllInCard` ("Pick all N here") covers current-location units.
- **Picked-from breakdown** (`mvUpdateSelFrom`/`mvDeselectLoc`, render.js): quick-pick grabs a unit WHEREVER it sits (intentional - enables "bring P1 home"), so a "rest of P1" tap after a partial move silently re-picks the party already dropped elsewhere and the next drop would yank them along (found by a phone-sim split-unit scenario; recovering by hand cost ~22s of scroll-and-audit, or worse went unnoticed).
  Fix: whenever anything is picked, the drop bar lists each source location as a ✕-token ("picked from: ✕ Range · 4"); one tap sheds that location's picks, so "rest of P1 → Bunk" is quick-pick P1, shed Range, drop (~11s).
  With a single location picked the token doubles as the ONLY clear-selection affordance - do NOT re-hide it for the single-card case (an earlier `size > 1` rule removed the token exactly when the last wrong contingent remained).
  Pure DOM inside `mvUpdateCount` (no re-render); tokens are built with createElement because location names aren't attribute-safe.
- **Find bar** (`mvFindFilter`, render.js): a phone-sim audit showed unit moves are 3 taps but locating ONE named recruit meant scanning ~36 chips over 3.6 screens - the only >30s flow left.
  The `#mv-find` input (rendered in BOTH modes, above the grid) live-filters chips by name/4D and collapses cards with no hits, so the surviving card header answers "where is he?" (out-of-camp chips match too).
  Pure DOM (`.mv-hide` class) - no re-render, so move-mode picks SURVIVE searches: search, tap, search the next, one drop. Hidden-but-selected chips stay selected by design.
- **Undo last move** (`MV_UNDO`/`mvUndoLastMove`, forms.js; button rendered in the drop bar AND view-mode actions, render.js): in move mode every card surface is a drop target, so a scroll-tap misfire silently commits the whole selection to that card - a phone-sim measured recovery of a mixed-source 11-body pick at ~35s of pure memory reconstruction (misremember one and the board is silently wrong).
  `moveToLocation` captures each body's PREVIOUS `{location, locationSince}` before mutating, so one tap restores every body to its own prior spot (not one bucket) across ALL mutation paths (drop bar, card tap, list picker, new-place drop, recallAll); the restore is captured too, so a second tap redoes (button label flips ↩ Undo / ↻ Redo).
  In-session module state, day-guarded (`MV_UNDO.day === todayISO()`) so a stale undo can't resurrect yesterday's locations.
- Automation: `recallAll()` (one-tap send everyone in camp back to Main Body). Manual backup kept: `openMoveForm` (the "📋 List picker" - grouped checkbox modal). **Buttons use the STANDARD `.btn`/`.btn-primary` sizing (no oversized variant - an earlier `.btn-lg` was removed as too bloated/inconsistent). `.mv-dest`/`.mv-qp` match `.btn` proportions. Keep it consistent with the rest of the app.**
- **Dashboard hero** (`renderDashMovement`, placed right after the strength tiles): a prominent `.mv-hero` card with a single distribution BAR (segment width ∝ headcount, one colour per location via `mvColor` - shared with the tab so a place reads the same everywhere) + tappable legend, all `gotoNav('movement')`. Shows the whole company (in-camp + Out of Camp) so the bar reconciles to strength. `gotoNav(key)` (main.js) is the programmatic tab switch.
- Playground: `dev-seed.html` (repo root) seeds a rich 40-recruit demo company into localStorage (no backend/invite) and opens the app - for local UX testing. Serve with `python3 -m http.server` and open `/dev-seed.html`.

## Data modeling
- Rows are keyed by `id`; upsert overwrites on id match -> **duplicate IDs are data corruption** (happened with conduct IDs: several conducts shared one id and attendance rows collided). Validate uniqueness on import.
- Platoon/section scoping is data-driven: `getPlt` reads an explicit `plt` column, else parses the 4D code (`C1404` -> plt 1, sect 4). Commanders (`00xx` ids) are coy-level unless given an explicit `plt`. New platoons need zero code changes - but only if their 4Ds follow the digit convention; otherwise fill the `plt`/`sect` columns.
- Normalizers run at every read boundary (`normalizeRoster` etc.): pad 4Ds, coerce Sheets' `"TRUE"` text to real booleans, migrate legacy enum spellings one-way.

## Testing - `node test/run.js`
- The harness loads the REAL backend + frontend files in `vm` sandboxes with mocked Google services (`test/mocks/google.js`). Keep it zero-dependency.
- **Known blind spots (be honest about them):** the mocked `LockService` is a no-op so real concurrency/latency bugs are invisible; mocks store strings verbatim so Sheets' type coercion is unreproducible; and a passing test can encode a buggy design as expected behavior (happened). For unreproducible failure classes, add **static lint tests over the source** instead of behavioral tests.
- Static guards that earn their keep: parse-all-scripts-together, uniform `?v=`, unbumped-write scan, raw-setValues scan.
- When the backend gains a new Google API call (e.g. `setNumberFormat`), the mock in `test/mocks/google.js` must grow it or every write test fails.

## Parade state / domain formats
- OTHERS entry for a booked-out-via-appointment recruit:
  `S/N: 06` / `R/N: REC <NAME> <4D>` / `Reason: <reason> (MA)` / `Location: <location>` / `Date: DDMMYY` / `Time: HHMM Hrs`.
- Strength block: TOTAL = whole roster; CURRENT = TOTAL - `outOfCampMap` keys; per-platoon breakdown auto-derives from `getPlt`.

## Working style for this project
- Changes go live to many low-tech users on phones - reliability and *obvious* status indicators trump elegance.
- Prefer manual controls with automatic safety nets (e.g. manual Book In + auto-clear next day).
- When a bug slips past the tests, explain honestly why the harness missed it and add a guard for that failure class.

---

# Medical status + conduct wizard - lessons (helpers.js / forms.js)

Deeper notes on the medical-status engine, custom statuses, the conduct wizard, and time display. Complements the sync/Sheets section above.

## Medical status engine (helpers.js)
- Every Medical row is a "report sick" event; `status` is the MO outcome. Fields: id, d4, date, reason, status, startDate, endDate.
- Canonical vocabulary: `MED_STATUS_GROUPS` / `MED_STATUSES`. Away-from-camp: MC, Warded. In-camp restricted: LD, Excuse X (incl. "Excuse RMJ"). Awaiting MO: Pending (active only on its start date). Cleared: NIL (never active).
- Standalone "RMJ" was REMOVED from the selectable dropdown (only "Excuse RMJ" remains). Legacy RMJ render/rank/parade handlers were left in place so any old RMJ records still display. Purge them only once confirmed no legacy data exists.
- Core functions: `medStatusActive(rec, iso)`, `medStatusTag(rec, iso)` -> `{tag, ghostDay}` (ONLY MC and LD get +1/+2 ghost tags for the 2 days after expiry), `medSeverityRank(tag)`, `currentMedicalEffective(iso)` (one dominant status/recruit), `currentMedicalEffectiveAll(iso)` -> `{d4, statuses[], hidden[]}` (all distinct statuses/recruit).
- **Same-family dedup:** duplicates of the same base status (MC/MC, MC/MC+1, LD/LD+2) collapse to most-severe-then-most-recent; collapsed ones move to `hidden[]`. Base family = strip "+N" via `medStatusBaseFamily(tag)`. Different families (MC + LD + Excuse) still stack. This is what stopped the dashboard table and the Status Breakdown pie from double-counting a re-issued status. Full history stays visible in `openPerson()`.
- `dedupeActiveRecordsByFamily(records)` applies the same collapse to raw records; used by parade state (`buildMedicalSection`) and conduct chat (`buildConductChatFormat`).

## Custom statuses
- `STATE.customStatuses` = `[{name, participates}]`, persisted in localStorage key `cougar-custom-statuses`.
- `loadCustomStatuses` / `saveCustomStatuses` live in **state.js** (MUST be there - `STATE` initializes before helpers.js loads).
- Runtime helpers in helpers.js: `customStatusByName`, `addCustomStatus`, `statusParticipates`.
- Custom statuses are in-camp/restricted, rank ~55, get a teal badge, never get +1/+2 tags.
- Created inline in the Report Sick form (`openMedicalForm`) via a "+ New custom status" option with "Still participates" and "Save for reuse" checkboxes; handled in `submitMedical`.

## Conduct wizard (openLogConductWizard, forms.js)
- Status Personnel list is built by `rebuildLogConductStatus` from `currentMedicalEffectiveAll`.
- Commanders are EXCLUDED (`.filter(({d4}) => !isCommander(d4))`) - the company does not track them in conduct attendance. Fallout / Report Sick add-row pickers use `rosterSelect(id, true, val, "Recruit", {...})`. Default total strength already excludes commanders.
- First-time "not participating" default comes from `statusParticipates`: if EVERY active status participates (e.g. a custom "Excuse Finger" who still runs) the recruit is auto-unticked; any restrictive status defaults to not-participating. User can override per conduct.
- Note: built-in statuses have fixed participation (only NIL participates); the flag applies to custom statuses. Per-built-in overrides are a possible follow-up.

## Time display: fmtHrs vs pad4Time (gotcha)
- `pad4Time(t)` is a NORMALIZER, used for BOTH storage (`entry.time = pad4Time(...)`) AND matching/inference keys (conduct rows keyed by (date, time, conductId)). NEVER bolt display formatting onto it - it corrupts stored times and breaks conduct matching.
- `fmtHrs(t)` is the DISPLAY-only formatter (normalizes then appends " Hrs" -> "0730 Hrs"). Use it at render / parade-state emit points only. It skips durations (anything with ":", e.g. RM/SOC "12:34") and non-time strings.
- Applied everywhere a clock time is shown: parade state, conduct chat, attendance/detail tables, dashboard appointments. RM/SOC are durations - never `fmtHrs` them.
