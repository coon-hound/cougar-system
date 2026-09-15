# Usage telemetry — design

Why this exists: we want evidence, not opinion, about what belongs at the top of the dashboard.
Two questions drive every design decision below.

1. **What do people actually open?** Which views, forms and reports get used, how often, by whom.
2. **What costs them the most clicks?** How many taps does a real task take end to end, and where do people give up.

The output is a ranking: high-frequency and high-cost features get promoted toward the front of the dashboard.

## Constraints that shape the design

The app is a no-build, plain-`<script>` SPA.
`render()` replaces `#content.innerHTML` wholesale on every view change, so nothing bound per-element survives a repaint.
All 176 handlers are inline `onclick="someGlobal(...)"` attributes baked into template literals in `js/render.js` and `js/forms.js`.

That last fact is the opportunity.
We do not need to touch a single call site to instrument this app.

## Instrumentation strategy

### Layer 1 — raw click capture

One `document.addEventListener("click", fn, true)` in the **capture** phase.

Capture is mandatory, not a preference.
`index.html` puts `onclick="event.stopPropagation()"` on `.modal`, and several row-action buttons call `event.stopPropagation()` inline, so a bubble-phase listener would silently miss every click inside a modal and every row action - which is exactly where the expensive tasks live.
Capture runs before any target handler, so it sees everything.

Each click resolves to a stable **target descriptor**, cheapest signal first:

- an explicit `data-tel` attribute, if one was added
- the `onclick` attribute's leading function name, normalised (`openPerson('R123')` -> `openPerson`) - never record the arguments, they contain personal identifiers
- `data-nav` / `data-role` for sidebar and filter controls
- a semantic fallback built from markup alone: `tag.class#id`

**Correction to the original design: the fallback does NOT read element text.**
This draft said "trimmed text content, capped and stripped of digits".
Stripping digits defeats a 4D but it does not defeat a NAME, and in this app a roster row's text is routinely `1101 TAN WEI MING`.
There is no reliable way to tell a UI label from a soldier's name after the fact, so the text is never read at all.
`class` and `id` in this codebase are static markup (`.nav-btn`, `.role-btn`, `#pull-btn`) and carry no data, which makes the descriptor both deterministic and provably clean.
Anything that needs a friendlier label should carry an explicit `data-tel`.

The guard is an **allow-list, not a deny-list**.
`scrubName` first deletes any run of two or more digits (a 4D, a date, a phone number - no handler name in this codebase contains a digit at all).
`isSafeName` then admits only single identifier-shaped tokens: `submitBookOut`, `nav:roster`, `role:Commander`, `button.btn#pull-btn`, `book_out`.
Prose carries whitespace and a descriptor never does, so anything with a space is refused outright rather than cleaned and stored.
The Edge Function applies the same two rules again on the way in, because the client is public code and a hand-crafted request is not hypothetical.

### Layer 2 — task funnels

A "task" is a named unit of intent with a start and a terminal.
We do not hand-annotate 176 call sites. We wrap the globals.

`js/telemetry.js` loads **last**, after every other script, and monkey-patches a declared registry of global functions.
The registry as built covers 19 tasks, every name verified against `js/forms.js` rather than guessed (a unit test keeps it honest as the app changes):

| task | start | done |
| --- | --- | --- |
| `book_out` | `openBookOutForm` | `submitBookOut` |
| `book_in` | - | `markPresentToday` |
| `undo_book_out` | - | `undoBookOut` |
| `log_leave` | `openLeaveForm` | `submitLeave` |
| `appointment` | `openAppointmentForm` | `submitAppointment` |
| `medical_status` | `openMedicalForm` | `submitMedical` |
| `log_conduct` | `openLogConductWizard` | `saveLogConductWizard` |
| `attendance` | `openAttendanceForm` | `submitAttendance` |
| `conduct_detail` | `openConductDetailForm` | `submitConductDetail` |
| `ippt_entry` | `openIPPTForm` | `submitIPPT` |
| `rm_entry` | `openRMForm` | `submitRM` |
| `soc_entry` | `openSOCForm` | `submitSOC` |
| `report` | `openReportModal` | `copyReportToClipboard` |
| `parade_compare` | `openCompareModal` | `copyCompareSummary` |
| `person_lookup` | - | `openPerson` |
| `groups` | `openGroupsForm` | `submitGroupNames` |
| `group_members` | `openGroupMembersForm` | `submitGroupMembers` |
| `combined_group` | `openCombinedForm` | `submitCombined` |
| `commander` | `openCommanderForm` | `submitCommander` |

A `start` of `-` is an **instant task**: a one-tap action with no funnel, which begins and ends inside the same call.

Two details the wrapper has to get right.
An `async` submit returns a promise, so the wrapper observes it with `.then(ok, err)` and returns the *original* promise untouched - the caller's handling is unchanged and the derived promise carries its own rejection handler.
And the click counter starts at **1**, not 0: the capture listener runs before the inline handler, so at the instant the form was opened there was no task to attribute that tap to, and ignoring it would understate every cost by one.

The wrapper preserves the original function's behaviour exactly - same `this`, same arguments, same return value, and it must not swallow exceptions.
If a declared global does not exist at load time the entry is skipped with a console warning rather than throwing; the registry will drift as the app changes and drift must never break the app.

A task session records: start time, the click count accumulated since start, and how it ended.

- **completed** - the `done` function ran without throwing
- **abandoned** - the modal closed, or the user navigated away, before `done`
- **superseded** - a new task started while one was open

Abandonment rate is as interesting as click cost. A form people open and back out of is a form with a problem.

### Layer 3 — view dwell

Every `STATE.nav` change records the view left, the view entered, and the dwell time on the one being left.
This is what answers "what do people actually open".

It is implemented by wrapping the global `render()` rather than editing `js/main.js`, since every nav change already goes through it.
One trap, and it cost a green-looking build: `STATE` is a top-level `const`, and **a top-level `const` is not a property of `window`** - only `function` declarations are.
Reading it as `window.STATE` yields `undefined`, every dwell measurement resolves to the same empty view, and telemetry silently records nothing while looking installed.
It must be referenced lexically as bare `STATE`, which works because all `js/*.js` share one global scope.

## What gets stored

Everything lives under one dedicated key, `cougar-usage-v1` - deliberately NOT inside the versioned `cougar-data-v3` blob, so a data-cache reset does not wipe the record.
It holds three layers:

- `buf` - the raw event stream, capped at 400 and pruned oldest-first so a long-lived phone never fills its quota.
- `days` - cumulative pre-aggregated counters, 30 days deep. This is what the insights view reads, and it is why pruning the buffer loses nothing that matters.
- `pending` - the delta not yet flushed to Postgres, cleared only on a confirmed flush.

An event is `{t, k, n}` plus `ms` for a view, and `o` (outcome) / `c` (click count) / `ms` for a task terminal.
`k` is one of `click`, `view`, `task_start`, `task_end`; `n` is always a scrubbed descriptor and never anything else.

Events are **not** attributable to individual people beyond the acting user's own identity, and no event ever carries a 4D, a name, a medical tag or a free-text reason.
We are measuring the shape of the UI, not watching the users.

## Sync

Per the product owner's decision, usage data syncs to Postgres from the start, so it aggregates across the company rather than stranding on one phone.

It does **not** ride the normal sync cycle, and that is a deliberate correction rather than a shortcut.
The existing machinery is built for small, hand-edited, bidirectionally-synced tables under optimistic concurrency, and every write bumps that table's rev.
Every other open phone polls `revCheck` on a 20-second timer and pulls whatever changed.
Put a high-volume append-only event stream behind that and each recorded click makes every other device in the company pull - a self-inflicted polling storm, paid for on mobile data, to deliver data no client's UI is even reading.

So the usage table is deliberately excluded from `REV_TABS` and from `readAll`.
The client buffers events locally and flushes them in batches through a dedicated append action.
The insights view reads them back through its own on-demand query action when someone actually opens it, never as part of a launch pull.

Concretely: `API.usageAppend` / `API.usageBeacon` / `API.usageRead` carry no `tab` and no `baseRev`, they are dispatched in the Edge Function *before* the tab lookup, and neither goes through `withRev`.
Nothing marks a tab dirty and nothing enters the per-tab write queue.
A flush runs on a 60-second timer (fetch, so the outcome is known and the delta is cleared only on success) and on `visibilitychange` -> hidden (`navigator.sendBeacon`, since a fetch is not guaranteed to survive the page going away).
A failed flush is never surfaced: the delta stays pending and goes out with the next batch.

**The server side is rolled-up counters, not raw events**, and the reasoning is in the header of `supabase/migrations/0005_usage.sql`.
Every question here is an aggregate, so raw events would mean ~100k rows a week to answer what a `GROUP BY` over a few hundred counter rows answers exactly as well.
A counter row is `(day, device, kind, name, integers)` - there is nowhere for a 4D or a name to live even if the client scrub failed, which makes the privacy property structural rather than a matter of client-side discipline.

An additive upsert is not idempotent, and a beacon's outcome is unknowable, so every flush carries a `batchId`.
The server inserts it into `usage_batches` first; a redelivered batch conflicts there and short-circuits before any counter moves.

The device is identified by a short FNV-1a hash of the `cougar-auth` token, never the token itself - that token is a live credential and must not be written into a data table.

This gets the product owner's company-wide aggregate exactly as asked, without letting analytics degrade the app it is measuring.

## Non-negotiables

Telemetry is a passive observer.
It may never change what the app does, never block a user action, and never throw into a user's path.
Every entry point is wrapped so that a failure inside telemetry is caught, logged once, and swallowed.
If the analytics layer is broken, the app must behave exactly as though it were absent.

## Wiring

`js/telemetry.js` and `js/render-usage.js` are inert until `index.html` loads them and `render()` gains a dispatch case.
Load order matters: `render-usage.js` anywhere after `render.js`, and `telemetry.js` **last of all**, so every global it wraps already exists.

## What this is not

It does not record per-session sequences ("which path did they take through the wizard").
That is a different question from the one being asked, and raw events can be added later as a second table without touching the counter one.

It does not attribute anything to a named person.
There is no user identity in this app; one device is approximately one person, and that is enough to tell "everyone does this" from "one person does this a lot".
