# CLAUDE.md

Condensed working notes for coding agents.
The long-form reasoning behind all of this is in [docs/HANDOFF.md](docs/HANDOFF.md); read it before any non-trivial change
(note it predates the Postgres backend and still describes Sheets in places).
[DEV-ENV.md](DEV-ENV.md) gets a real backend running locally.

## What this is

Phone-first vanilla-JS web app for 40 SAR Cougar Company.
The backend is Postgres on Supabase, reached through one Edge Function that speaks the exact protocol the old Apps Script web app spoke, so `js/api.js` and `js/sync.js` did not change.
Apps Script still owns Gmail, the Claude vision proxy and the Telegram bot, and those three actions proxy through to it.
No React, no bundler, no build step.
`js/*.js` are plain `<script>` tags loaded in a fixed order, so they share one global scope.

**Phone-first is the primary constraint.** Commanders use this one-handed, outdoors, on mobile data. Layouts, tap targets and payload sizes are judged on a phone first, desktop second.

## Rules that are enforced by tests

Break one of these and `node test/run.js` fails.

- **Bump `?v=` in `index.html` on every `js/*` or `styles.css` change.** It is a single uniform number across all script tags and `styles.css`; a static test enforces they all match. Without the bump, phones keep running stale cached code.
- **No duplicate top-level `const` / `let` across `js/*.js`.** All files are concatenated into one scope. A duplicate declaration blanks the entire dashboard at load. The static guard compiles all files as one program to catch this.
- **Every direct write to a tracked tab must be followed by a `bumpRev`.** Otherwise other devices never learn the data changed. A heuristic scan checks for this.

## Rules that are not enforced, and will bite you

- **`padD4()` is load-bearing.** The 4D is the universal join key, and every read boundary re-pads because commander ids like `0001` lose their leading zeros in transit. Do not bypass it.
- **The 4D is a seat, not a person.** Digit 1 is the platoon and digit 2 the section (`getPlt`/`getSect` in `js/helpers.js`), so the whole range is reissued to different people every intake, and `roster.id` **is** the 4D **and** the primary key. Anything reasoning about a person across time needs `people.pid`. See [docs/INTAKE-MIGRATION.md](docs/INTAKE-MIGRATION.md) for a whole new cohort, and [docs/RESEAT.md](docs/RESEAT.md) for re-dealing one platoon's seats. **Never hand-write the 4D rename**: it overlaps itself, the primary key is not deferrable, and a dozen child tables join on it - use `scripts/reseat.mjs`.
- **`role` and `rank` are different fields and only one of them moves.** `role` is the two-valued Commander / Recruit switch that ~20 call sites scope on; `rank` is REC, PTE, 3SG. A cohort enlists as REC and is promoted to PTE on posting into unit training, so never print a rank as a literal - `rosterRank(r)` in `js/forms.js` reads the column and falls back to `REC`.
That rule covers `apps-script-Code.gs` too: the Telegram bot printed `"REC "` at four call sites for a year, so a PTE reporting sick reached his SC as a recruit. Use `tgRank()` there.
Moving the whole company's rank is `scripts/promote.mjs` - see [docs/PROMOTE.md](docs/PROMOTE.md).
`PC_RANKS` in `js/parade-compare.js` must list every rank the app can render, or a promotion makes the man diff as removed **and** added.
- **There is ONE rank vocabulary and ONE rank order: `RANK_TIERS` in `js/helpers.js`.** `RANK_OFFICER` / `RANK_WOSPEC` / `RANK_ENLISTEE` and `rankCategory` are derived from it, and `sortByRank(list, tie)` is what every senior-first list uses (Roster table, every `rosterSelect` picker, the FP/LP duty pickers, the Access picker). Rank is the primary key and the caller's old sort stays as the tie-break, so 4D order inside a rank is unchanged. Rank is free text off the roster column: an unknown or blank rank sorts LAST and must never throw. The only other rank list is `PC_RANKS` in `js/parade-compare.js`, which is a loose *stripping* regex for parsed parade text (it also carries `CDT`), not an ordering - adding a rank means touching both.
- **The `normalize*` functions must keep emitting the full schema** on every record, blank `startDate` / `endDate` included. The Postgres backend no longer derives columns from row 0's keys the way `writeTab` did, but the frontend still assumes a uniform shape everywhere.
- **Prefer `upsertRow` / `deleteRowById` over a full-table `pushTab` write.** ID-based surgical writes are cross-device safe; a full-table rewrite clobbers a concurrent edit from another phone.
- **`apps-script-Code.gs` is a mirror, not the running code**, and it now serves only Gmail, vision and the Telegram bot. The executing copy lives in the Apps Script editor and is updated by pasting this file; edits do not propagate either direction.
- **A conduct is logged against a SCOPE**, stored on the record in a field still named `program`: the whole company, a platoon (`plt:N`), a named group (`grp:NAME`) or a saved combined group (`comb:NAME`). The field keeps that name because it also holds archived bare program keys, and the sheet column and the dedup tuple are built on it. Never write `prog:KEY` - it would alias a bare key and split the tuple. The PTP / BMT / Combined program dimension it replaced is gone; archived rows still carrying `PTP`/`BMT` resolve company-wide and keep their original label.
- **The parade state is the battalion's format, and the parser must keep understanding BOTH.** `generateParadeStateText` emits the 40 SAR format (blocks, six fixed sections, one line per record); `js/parade-compare.js` parses it AND the pre-Sep-2026 S/N-block format, because saved snapshots are the ground truth of what was filed and are never regenerated. A round-trip test pins parser and generator together, so any change to the emitted text updates the parser in the same PR.
- **Anything free-text rendered into a parade line goes through `paradeSafeText`.** The line format gives `" - "`, `(`, `)` and `@` structural meaning, so a reason of `Fever (38.5)`, a location of `Raffles @ Sembawang`, or a newline pasted from WhatsApp silently corrupts or splits a record - and a split record still counts in its section header, so the state disagrees with itself. The fuzz test in `test/parade-format.test.js` is what catches this; extend it when you add a field.
- **Parade strength never counts section lines.** Present/strength comes from `outOfCampMap` plus the ticked borderline returnees, so a person legitimately listed on several lines (an MC and an excuse) is still one body, and the blocks always add up to COMPANY.
- **Derived state is derived.** Out-of-camp status and the movement board are computed from their source records, never stored separately. Do not introduce a second copy.

## The Postgres backend

- **Run things against the real backend before believing them.** `scripts/dev-env.sh up` gives a real Postgres, the real Edge Function and the real frontend with no Docker and no cloud. This is not optional polish: the intake changeover passed its unit tests and then failed three times in a row on the first real run (a foreign-key ordering problem, rows inheriting the wrong intake stamp, and commanders left stamped with the archived cohort).
- **Every upsert ends `deleted_at = null`.** Deliberate - a delete-then-append should revive the row - but any path that soft-deletes for a *durable* reason needs a trigger to defend it. See `keep_archived_archived` in `0004_intake.sql`.
- **A full-tab write HARD-deletes MSK** before reinserting, because MSK has no `id` to diff on. A soft delete does not protect MSK rows; a `before delete` trigger does.
- **`dropped_fields` is cached in a module-level variable** for the life of a warm instance, so adding a row to it needs a redeploy to take effect. It doubles as the way to make a column server-owned: the client can still read it via `api_row`, but `shapeRow` drops it on the way in. That is how `roster.pid` and `roster.intake` stay unwritable by any phone.
- **`api_row` returns every real column**, so adding a column to a table puts it in every `readAll` response and in anything that copies a row. Set derived values *after* copying a source row, not before.
- **A killed migration leaves its transaction open.** `idle_in_transaction_session_timeout` is `0` on this database, so a client killed mid-run holds its row locks until the connection drops, and the next run blocks on them silently. Check `pg_stat_activity` before assuming a rerun is merely slow.

## Personnel data rules

- `*.csv` is gitignored on purpose: real nominal rolls must never land in the repo. `docs/nominal-roll-template.csv` is the one exception and is entirely invented names.
- Eight roster columns are encrypted at rest (`0002_security.sql`). Do not read them into a script unless it genuinely needs them; matching people by name does not.
- NRIC is never stored, only a **keyed** digest of the **whole** value. An unkeyed hash is not good enough - the space is small enough to walk offline, so the digest would effectively be the value.
- **Do not key on the last four characters.** It was built that way, and the first real changeover found two collisions among 96 enlistees (`T0627509A`/`T0410509A`, `T0808034D`/`T0473034D`). The unique index turns the first collision into an aborted run; the quiet failure is a later intake matching a stranger onto someone else's medical history at a tier that reports itself as exact. A bare suffix now keys to `""` and falls back to name matching.

## Names in this dataset

Matching people by name needs an unordered token set, not a string compare: `TAN WEI MING` and `WEI MING TAN` are the same person, and `BIN` / `S/O` / `BINTE` carry no information.

Do not trust a loose similarity threshold. The token pool is small (LIM, TAN, WEI, KAI, JUN), so two shared tokens means very little: `JOSHUA LIM KAI EN` scores 0.67 against `KAI XIN LIM`. Anything short of an exact match should ask a human rather than guess, because the thing being guessed at is whose medical records these are.

Source documents disagree, and the database is the tiebreak. The intake 16 attendance tracker read `W` as `V` across about twenty names (`CHEV KAI XIANG` for `CHEW`, `TOH VEN HO` for `WEN`), while the self-reported in-processing form had its own typos. Where a person is already in `roster`, that spelling wins.

## Shipping a change

Full detail in [docs/PIPELINE.md](docs/PIPELINE.md). The short version:

```bash
scripts/new-feature.sh feat my-thing    # worktree + branch off master
cd .worktrees/my-thing
bash scripts/verify.sh my-thing         # the gate; writes EVIDENCE.md
bash scripts/preview.sh my-thing 8080   # click through it in a real browser
scripts/ship.sh "feat: my thing"        # verify, commit, push, open PR
```

`master` is production.
One feature, one worktree, one branch, one PR, branched off clean `master` so PRs merge in any order.

`EVIDENCE.md` is generated by `verify.sh` and is git-ignored.
`ship.sh` uses it as the PR body, so the evidence lands durably on the PR rather than as a per-branch file that conflicts on every merge.

## Testing

```bash
npm test           # node test/run.js: sync units, multi-tab sync, static guards. Zero-install.
npm run test:e2e   # Playwright, headless Chromium against seeded demo data, offline.
```

The e2e suite works because the app renders purely from `localStorage` when `STATE.authToken` is empty.
The fixture is `test/e2e/fixtures/demo-seed.json`, seeded via `context.addInitScript`.
**All seed logic stays in dev/test files, never in `js/*`.** Production must be untouched by test scaffolding.

Add a spec per frontend feature under `test/e2e/*.spec.js`.

The Playwright static server's port is **derived from the checkout path**, and the server is pinned with `--directory`.
It used to be a fixed 5599 with `reuseExistingServer`, which meant a worktree's run silently adopted whichever checkout started the server first and tested code it did not contain - a spec passing against the wrong tree, with nothing in the output to say so.
`PW_PORT` still overrides if you need a specific port.

`js/state.js` is no longer loadable on its own: its read-boundary normalizers call into `js/helpers.js` (`canonMedStatus`), so the node harnesses load `helpers.js` first, exactly as `index.html` does.

## Conventions

- No em dashes in prose or commit messages. Use a plain dash.
- Do not hand-edit anything marked auto-generated.
- Long Markdown files: one sentence per line.
