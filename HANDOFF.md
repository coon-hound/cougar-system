# Cougar Company Data System — Handoff Document

> A single source of truth for 40 SAR Cougar Company training, medical & fitness data.
> Phone-first web app on top of a Google Sheets backend. No server, no build step, no framework.
> Last updated: 2026-06-18.

---

## 1. What this is, in one paragraph

A vanilla-JavaScript web app (no React, no bundler) that reads and writes a Google
Sheet through a Google Apps Script web app. Commanders open it on their phones to
manage the company's roster, attendance, medical status, leave, IPPT/route-march/SOC
results, and Polar heart-rate analytics. Two "wow" features: **AI photo capture**
(photograph a Polar Flow class summary, Claude reads every row and matches it to the
roster) and **performance analytics** (derived training-science metrics per recruit).
There is also a **Telegram bot** for field data entry (report sick, MC photo upload).

---

## 2. Architecture at a glance

```
┌─────────────────────────────┐         ┌──────────────────────────────┐
│  Front end (this repo)       │  HTTPS  │  Google Apps Script web app   │
│  vanilla JS, no build        │ ──────► │  apps-script-Code.gs          │
│  served as static files      │  JSON   │  doGet / doPost routers       │
│  runs offline from cache     │ ◄────── │  + Telegram webhook handler   │
└─────────────────────────────┘         └───────────────┬──────────────┘
        │ localStorage cache                             │ SpreadsheetApp
        ▼                                                ▼
   per-device auth token                      ┌────────────────────────┐
                                              │  Google Sheet (the DB)  │
   Integrations:                              │  one tab per module     │
   • Claude API (photo extraction)            │  Roster, Medical, IPPT…  │
   • Gmail (fitness report emails)            └────────────────────────┘
   • Telegram Bot API (field entry)
```

- **Front end**: plain `<script>` tags, no modules, so it runs from `file://` too.
  Load order matters (see [index.html](index.html#L80-L87)):
  `state → api → ippt-scoring → helpers → render → forms → sync → main`.
- **Backend**: a single Apps Script file, [apps-script-Code.gs](apps-script-Code.gs).
  This file is the deployed copy — the live web app is edited in the Apps Script
  editor; keep this repo copy in sync with it manually.
- **Database**: a Google Sheet, one tab per data module. Apps Script generates sheet
  headers from `Object.keys(data[0])` of whatever it's told to write — see the schema
  warning in §6.

---

## 3. Repo layout

| Path | What it is |
|---|---|
| [index.html](index.html) | App shell: sidebar nav, topbar search/filter, modal host. Bumps `?v=` cache-buster on every JS/CSS change. |
| [styles.css](styles.css) | All styling, including mobile breakpoints. |
| [js/state.js](js/state.js) | Global `STATE` object, localStorage cache (`saveLocal`/`loadLocal`), all the `normalize*` functions, `padD4`. **The data model lives here.** |
| [js/api.js](js/api.js) | Thin `API` wrapper over the Apps Script web app. `pullAll`, `upsertRow`, `deleteRowById`, `sendEmail`, `analyzePhoto`, `redeemInvite`. |
| [js/ippt-scoring.js](js/ippt-scoring.js) | IPPT scoring tables / award computation. |
| [js/helpers.js](js/helpers.js) | Shared utilities: roster filtering, plt/sect getters, date formatting, status logic. |
| [js/render.js](js/render.js) | All `render*` view functions (dashboard, roster, medical, IPPT, polar, MSK analytics, conducts…). View layer. |
| [js/forms.js](js/forms.js) | All modal forms + submit handlers, the Polar import flow, and the **parade state generator** (`buildStrengthBlock`, `generateParadeStateText`). Largest file (~3.8k lines). |
| [js/sync.js](js/sync.js) | Push/pull orchestration, dirty-tab tracking, offline retry, sync indicator. |
| [js/main.js](js/main.js) | Bootstrap: invite redemption from `?token=`, nav/search wiring, auto-sync on launch, dirty-restore prompt. |
| [apps-script-Code.gs](apps-script-Code.gs) | **The entire backend.** Routers, auth/invites, sheet I/O, Claude proxy, Gmail, Telegram bot. |
| [PRESENTATION.md](PRESENTATION.md) | Pitch deck for battalion HQ (slide-by-slide, fill the `[brackets]`). |
| `sample_*.csv` | Example Polar / conduct-detail import files. |
| `todo.txt`, `doublecheck.txt` | Loose open items (see §8). |

---

## 4. Data model (STATE)

`STATE` (in [state.js](js/state.js#L118)) holds one array per module, all keyed off a
recruit's **4D** (a 4-digit ID). Tabs ↔ state arrays are mapped in `TAB_TO_STATE`:

| Sheet tab | STATE key | Notes |
|---|---|---|
| Roster | `roster` | Source of truth for people. `id` mirrors the `4d` column. Role auto-detected: IDs matching `00xx` → Commander. |
| Medical | `medical` | Report-sick / excuse statuses with start/end dates. |
| Attendance | `attendance` | Per-conduct attendance; LMS column auto-recomputed from Polar. |
| IPPT / RouteMarch / SOC | `ippt` / `rm` / `soc` | Fitness results. |
| PolarFlow | `polar` | HR/calorie/duration per recruit per conduct. Source of truth for "who wore the watch". |
| ConductDetail | `conductDetail` | Per-conduct per-recruit detail rows. |
| Appointments | `appointments` | Medical/admin appointments, with in/out-of-camp handling. |
| Leave | `leave` | Leave/Out records. |
| MSK | `msk` | Musculoskeletal injuries, fed from a Google **Form**; verbose headers normalized in `normalizeMSK`. |
| Conducts | `conducts` | Canonical conduct registry `[{id, name}]`. Other tabs reference conducts by `conductId`, not free text. |

**The 4D is the universal join key.** `padD4()` ([state.js:171](js/state.js#L171)) is
critical: it strips a leading `C`, then left-pads 1–3 digit numbers to 4 digits because
Google Sheets silently strips leading zeros from commander IDs like `0001`. Every read
boundary runs the data through `padD4` so all layers join cleanly.

---

## 5. Auth & deployment

- **No login screen.** Access is by a **per-device auth token** stored in localStorage
  (`cougar-auth`). A user gets one by opening an **invite link** (`...?token=XYZ`),
  which `main.js` redeems via `API.redeemInvite` → backend issues a device token →
  URL is scrubbed.
- **Issuing invites** is done from the Apps Script editor by running functions manually:
  - `generateInvite()` — single-use link.
  - `generateBulkInvite(maxUses, expiresInDays)` — shareable link, default 30 uses / 7 days.
  - `listInvites()`, `listAuthTokens()`, `revokeAuthToken(token)`, `revokeInvite(token)`,
    `revokeAllAuthTokens()` — management.
- **Deployment URL** is hardcoded in [state.js:8](js/state.js#L8) (`APPS_SCRIPT_URL`).
  **If you redeploy the Apps Script as a new version, you must paste the new `/exec`
  URL here and bump the `?v=` cache-buster in [index.html](index.html).**
- **Secrets** (Anthropic API key, Telegram bot token/secret) live in Apps Script
  **Script Properties**, never on the client. Set via `setAnthropicKey(key)`,
  `setTelegramSecrets(token, secret)`.

---

## 6. ⚠️ Gotchas / things that will bite the next maintainer

1. **Sheet headers come from the first row's keys.** `writeTab` builds the sheet's
   column headers from `Object.keys(data[0])`. If row 0 is missing a key that later
   rows have, that column is silently dropped for the whole push. This is why
   `normalizeMedical` etc. force every record to carry the full schema (e.g. always
   emit `startDate`/`endDate` even when blank). Preserve that discipline.
2. **`?v=` cache-buster.** Browsers (and phones especially) cache the JS hard. Every
   time you change a JS/CSS file you must bump `?v=N` in [index.html](index.html) or
   users keep running stale code. Currently at `v=94`.
3. **Two copies of the backend.** [apps-script-Code.gs](apps-script-Code.gs) in this
   repo is a mirror; the executing copy is in the Apps Script project. Edits in one do
   not propagate to the other — sync by hand.
4. **Prefer `upsertRow`/`deleteRowById` over `pushTab` (full rewrite).** The ID-based
   surgical writes are cross-device-safe: two phones editing different rows of the same
   tab won't clobber each other. A full-table `write` will. See [api.js:71](js/api.js#L71).
5. **Offline / dirty tabs.** Failed pushes mark a tab "dirty" (`cougar-dirty-tabs`,
   separate localStorage key so a cache clear doesn't lose it). On next launch the user
   is prompted to retry. Logic in [sync.js](js/sync.js) + `maybeRestoreDirty` in main.js.
6. **localStorage keys are versioned.** `STORAGE_KEY = "cougar-data-v2"`. Bump the
   suffix to force-invalidate stale caches in the field.
7. **LMS auto-recompute.** After every pull, attendance LMS counts are recomputed from
   Polar (`recomputeAttendanceLmsFromPolar`) — Polar is the source of truth for watch
   participation. Don't hand-edit LMS expecting it to stick.

---

## 7. Integrations

- **Claude API** — `analyzePhoto` action proxies one image through Apps Script
  (`analyzePhotoHelper`, [Code.gs:265](apps-script-Code.gs#L265)) to Claude. Returns
  `{ recruits: [{d4, avgHR, maxHR, calories, duration}], notes }`. `validD4s` is passed
  in to seed the prompt so Claude can discard misreads. Key in Script Properties.
- **Gmail** — `sendEmail` sends HTML fitness reports from the script owner's Gmail
  (subject to daily quota). `getEmailInfo` returns sender identity + remaining quota.
  Per-device "already sent" tracking in `cougar-fitness-sent`.
- **Telegram bot** — full conversational flow in the back half of
  [apps-script-Code.gs](apps-script-Code.gs) (functions prefixed `tg*`). Handles
  recruit self-registration (by 4D + name match), report-sick submissions, and MC
  photo uploads to a Drive folder. Runs via webhook (`setTelegramWebhook`) or polling
  (`startTelegramPolling`). State machine stored in Script Properties per chat ID.

---

## 8. Known open items (from todo.txt / doublecheck.txt)

- **HA (heat-acclimatisation) tracking**: track rest days before HA expiry; color-code
  recruits with minimal rest days; show min/max days to completion for single & extended HA.
- **Report-sick count fix**: multiple statuses for one report-sick event should count as
  one, not several.
- **Terminology to confirm**: are `LD` / `RMJ` / `Excuse X,Y,Z` semantically the same?
  (Affects badge colors and parade-state grouping.)

---

## 9. Running & developing locally

- It's static files — open [index.html](index.html) directly (`file://`) or serve the
  folder with any static server. No `npm install`, no build.
- To talk to real data you need a valid auth token in localStorage (`cougar-auth`),
  i.e. open the app once via an invite link, or paste a token manually for dev.
- To change the backend: edit the Apps Script project, **Deploy → Manage deployments →
  edit → new version**, then update `APPS_SCRIPT_URL` in [state.js](js/state.js#L8) and
  bump `?v=` if you also changed front-end code.
- `git` history is the changelog; commits are small and descriptive
  (`appointment out of camp handling`, `parade state bugfix`, …).

---

## 10. Key-man risk (be honest with whoever inherits this)

Right now one person maintains and operates this. The dependencies a successor must own:
a Google account that holds the Sheet + Apps Script + Gmail quota, the Anthropic API key,
the Telegram bot token, and the discipline to keep the repo copy of `Code.gs` in sync
with the deployed copy and to bump cache-busters. None of it is hard; all of it is
undocumented tribal knowledge until now — this document is the start of fixing that.
