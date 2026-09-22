-- ============================================================================
-- 0009_duty.sql - the commander duty schedule, the calendar, and the OIL ledger
--
-- NUMBERING: 0007 is departures (merged). `feat/conduct-archive` is still open
-- and also claims 0007, so it must renumber to 0008 on merge. This takes 0009
-- to leave that slot free rather than race it.
--
-- THE PROBLEM
-- -----------
-- The commander duty roster lives in a spreadsheet whose date cells carry a
-- 16-value dropdown, enforced by Excel data validation and an explicit
-- "exact match or it does not count" rule:
--
--   - OFF PDS CDS COS SENTRY GD AL IPPT PH MC WEEK XWB CONFINED NDP CDO
--
-- Those sixteen are NOT sixteen of the same kind of fact. The workbook only
-- gets away with conflating them because a human re-reads every cell. Four
-- kinds are mixed into one grid:
--
--   * an ASSIGNMENT  (PDS CDS COS SENTRY GD CDO) - a person, a date, a role;
--   * an ABSENCE     (OFF AL MC)                 - already owned by `leave`
--                                                  and `medical`, and read
--                                                  through outOfCampMap();
--   * a DATE FACT    (PH IPPT NDP CONFINED XWB)  - true for all 24 at once;
--   * and WEEK, which is getUTCDay() in (0,6) and is not stored data at all.
--
-- This migration stores the first and the third, and deliberately stores
-- NEITHER of the other two.
--
-- WHY NOT ONE FLAT duty(d4, date, code) TABLE, i.e. the spreadsheet transcribed
-- ---------------------------------------------------------------------------
-- Because MC is in that dropdown. Storing MC here would be a second copy of
-- what `medical` already says, and outOfCampMap (js/helpers.js) is the single
-- source of truth for who is out of camp - CLAUDE.md: "Derived state is
-- derived... Do not introduce a second copy." The divergence is not
-- hypothetical: the MO issues an MC on Tuesday, the flat cell still reads PDS,
-- and the schedule and the parade state then disagree about the same man on
-- the same day, with nothing to say which is right.
--
-- A row per (date, role, slot) also represents a man holding night sentry AND
-- a day duty on one date natively. The old workbook wrote "SENT/PDS" into one
-- cell, which is a string hack around a 1:1 schema; every consumer would have
-- to split on "/" forever, and the Guidelines rule "no CDS/PDS/COS the day
-- after night sentry" would be a substring hunt instead of a lookup.
--
-- And WEEK would be ~170 rows a month asserting what the calendar already
-- says. PH is the exact opposite - a public holiday is NOT derivable, so it
-- must be stored, but once per date rather than 24 times.
--
-- REJECTED ALTERNATIVES
-- ---------------------
--   * Storing the computed balances (OIL Left / AL Left). The workbook's own
--     guide sheet lists them under "CALCULATED - DO NOT TYPE OVER", so the
--     operator already believes they are derived. A stored balance drifts the
--     moment an OFF is corrected, and nothing recomputes it.
--   * A per-person oil_credit row per award. The workbook stores RULES
--     (Event | Applies To | OIL Days) and derives per-person entitlement from
--     them by SUMIFS. That is smaller, and it is the operator's mental model.
--   * A unique index on (date, role, slot). It would raise on a cross-device
--     collision, abort the Edge Function transaction, and js/sync.js would
--     retry the failing op forever - the company-wide write lockout that
--     keep_archived_archived (0004) was written to avoid by staying silent.
--     Instead the ID IS the natural key: 'duty-2026-10-01-PDS7'. Two phones
--     writing the same slot converge through the upsert that already exists,
--     with no constraint and no error path. The ids also contain "-", so
--     `+id` is NaN and can never coerce into another row's id.
--
-- DATES ARE ISO HERE, NOT DISPLAY STRINGS
-- ---------------------------------------
-- `leave` stores "17 May 2026" because Apps Script handed it over that way and
-- 0001 froze that to keep responses byte-identical through the cutover. These
-- tables never lived in Sheets, so that constraint does not apply. Every query
-- over them is a month RANGE, which a display string cannot answer without
-- calling displayDateToISO on every row, and dutyForDate (js/state.js) is
-- already ISO-keyed with a carry-forward rule that is a STRING COMPARISON.
-- Still `text`, per 0001's first design choice - just text that sorts.
--
-- Additive and re-runnable.
-- ============================================================================

-- ── 1. Duty assignments ─────────────────────────────────────────────────────
--
-- One row per (date, role, slot).
--
-- `role` is the UNION of the two vocabularies, not either one: CDO exists in
-- the app (paradeDutyRoles, js/forms.js) but not in the workbook, and SENTRY
-- is the reverse. Neither is dropped.
--
-- `slot` disambiguates multiple holders of one role on one date. The parade
-- state asks for one PDS PER PLATOON and keys it "PDS 7" / "PDS 8" / "PDS 9",
-- so the platoon number has to survive the round trip. SENTRY runs 9 a night,
-- so it numbers 1..9. Everything else is ''.
--
-- `status` is draft|published. The generator writes drafts; publishing is what
-- makes a month real. Without it, regenerating a month would silently rewrite
-- a command team that a filed parade state already named - and parade states
-- are never regenerated, so the two would disagree with no way to tell which
-- was filed.
create table if not exists duty (
  "id"      text primary key,   -- deterministic: duty-<date>-<role><slot>
  "date"    text,               -- ISO, "2026-10-01"
  "role"    text,               -- PDS | CDS | COS | SENTRY | GD | CDO
  "d4"      text,               -- commander 4D, padded (00xx)
  "slot"    text,               -- platoon for PDS, 1..9 for SENTRY, else ''
  "status"  text,               -- draft | published
  "source"  text,               -- manual | generated | import | legacy
  "note"    text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── 2. Calendar context ─────────────────────────────────────────────────────
--
-- A fact about a DATE, true for everyone: PH IPPT NDP CONFINED XWB, plus any
-- future company event. WEEK is absent on purpose - it is the day of the week.
-- "-" is absent on purpose - it is the absence of a row.
--
-- NOT intake-scoped, for the same reason 0004 excludes `conducts`: this is
-- recurring unit vocabulary, not a cohort's property. A public holiday belongs
-- to the calendar, not to the men who happened to be in camp for it, and
-- archiving sets deleted_at while every read is `where deleted_at is null` -
-- so stamping it would hide 2026's holidays from the 2027 cohort.
create table if not exists calendar (
  "id"     text primary key,    -- deterministic: cal-<date>-<code>
  "date"   text,                -- ISO
  "code"   text,                -- PH | IPPT | NDP | CONFINED | XWB | <event>
  "label"  text,                -- free text shown on the grid
  "note"   text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── 3. OIL entitlement rules ────────────────────────────────────────────────
--
-- The workbook's 'OFF Helper' rules table: Event | Applies To | OIL Days.
-- A commander's OIL Entitled is the SUM of the rules that apply to him:
-- every ALL rule, plus the rules for his appointment class, plus rules naming
-- him specifically. Days are fractional (0.5 occurs in the live data).
--
-- `appliesTo` is 'ALL', an appointment class ('VC' | 'SC'), or ONE COMMANDER'S
-- 4D. The workbook puts a FULL NAME in that cell; we store the 4D, because
-- this repo is public, and because a name is not a join key in this dataset -
-- the live workbook already has two personnel sharing a first name, one
-- disambiguated by hand with an appended surname. One typo there silently
-- re-points a man's balance, which is the same failure class as the NRIC
-- suffix collisions CLAUDE.md documents.
--
-- `days` is text like '0.5', per 0001 rule 1 (every data column is text). It
-- is summed in JS with an explicit +, never in SQL.
create table if not exists oil_rule (
  "id"         text primary key,  -- deterministic: oil-<slug(event)>-<appliesTo>
  "event"      text,              -- PANZER | ARR | NDP | IFC | GUARD DUTY | ...
  "appliesTo"  text,              -- ALL | VC | SC | <4D>
  "days"       text,              -- '4' | '2' | '0.5'
  "notes"      text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── 4. Roster columns ───────────────────────────────────────────────────────
--
-- NOTE api_row returns every real column (CLAUDE.md), so these four now appear
-- on EVERY roster row, recruits included, and in anything that copies one. Set
-- derived values AFTER copying a source row, not before. They are client
-- writable on purpose (no dropped_fields entry): the commander form owns them.
--
--   appt            VC | SC | ''   the Vehicle/Section Commander split the app
--                                  has no home for today. A REAL column rather
--                                  than an `extra` key (where plt/sect live)
--                                  because the OIL rule join reads it for every
--                                  commander on every render, and because we
--                                  are writing a migration anyway - plt/sect
--                                  are in `extra` only because nobody was.
--   oilTracked      'true' | ''    membership of the workbook's MASTER
--                                  PERSONNEL list. NOT derivable and NOT
--                                  inferable from a zero quota: 4 of the 24
--                                  commanders appear in the schedule and
--                                  deliberately have no ledger. "Appears in
--                                  the schedule" and "has an off budget" are
--                                  two different predicates, and inferring the
--                                  second from a blank quota would resurrect
--                                  those four as zero rows.
--   openingOilUsed  text           OIL consumed BEFORE the tracked period.
--   openingAlUsed   text           ditto, annual leave. Typed once, then left
--                                  alone. Without them every balance is wrong
--                                  on day one.
--
-- `leaveQuota` is REPURPOSED rather than joined by a new column: it already
-- defaults to 14 in openCommanderForm, and AL Entitled is 14 for every tracked
-- person in the workbook - the two numbers were always the same number. It
-- becomes the ANNUAL LEAVE entitlement. OIL gets no quota column at all,
-- because OIL is EARNED: a quota on it is a category error, and its
-- entitlement is the sum of the rules above. Nothing has ever rendered the old
-- label (commanderLeaveBalance has zero call sites), so no data moves.
alter table roster add column if not exists "appt"           text;
alter table roster add column if not exists "oilTracked"     text;
alter table roster add column if not exists "openingOilUsed" text;
alter table roster add column if not exists "openingAlUsed"  text;

-- ── 5. Indexes ──────────────────────────────────────────────────────────────
--
-- Every real query is a month range or one person's history. Partial on
-- deleted_at to match the convention in 0001 - a soft-deleted row must not
-- weigh on the live lookups.
create index if not exists duty_date_idx      on duty ("date")           where deleted_at is null;
create index if not exists duty_d4_idx        on duty ("d4")             where deleted_at is null;
create index if not exists calendar_date_idx  on calendar ("date")       where deleted_at is null;
create index if not exists oil_rule_ato_idx   on oil_rule ("appliesTo")  where deleted_at is null;

-- ── 6. RLS + touch triggers ─────────────────────────────────────────────────
--
-- RLS ON with NO POLICIES: anon and authenticated read nothing. All access is
-- the Edge Function on the service role, which bypasses RLS by role attribute.
-- Deliberately not FORCE ROW LEVEL SECURITY, exactly as 0001.
set client_min_messages = warning;

do $$
declare t text;
begin
  foreach t in array array['duty','calendar','oil_rule'] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop trigger if exists %I on %I', t || '_touch', t);
    execute format(
      'create trigger %I before update on %I
         for each row execute function touch_updated_at()', t || '_touch', t);
  end loop;
end $$;

-- ── 7. Intake scoping ───────────────────────────────────────────────────────
--
-- `duty` and `oil_rule` carry a d4 and are stamped; `calendar` is not (see §2).
--
-- A NOTE ON WHAT THIS ACTUALLY DOES, because it is not what it looks like.
-- Every d4 in these two tables is a COMMANDER, and scripts/intake-migrate.mjs
-- SKIPS commanders when archiving and rolls them forward to the new label. So
-- these rows will never actually archive. The stamp exists so the ROLL-FORWARD
-- loop picks them up: a commander row left on a departed cohort's label is the
-- bug intake-migrate.mjs documents - it can be soft-deleted in the app and then
-- never revived, because keep_archived_archived silently declines the revival
-- and the user sees a write that reports success and does nothing.
--
-- Both tables must therefore also be added to COHORT_TABLES in
-- scripts/intake-migrate.mjs, in the same change as this migration.
do $$
declare t text;
begin
  foreach t in array array['duty','oil_rule'] loop
    execute format(
      'alter table %I add column if not exists intake text default current_intake()', t);
    execute format(
      'update %I set intake = current_intake() where intake is null', t);
    execute format(
      'create index if not exists %I on %I (intake) where deleted_at is null',
      t || '_intake_idx', t);

    execute format('drop trigger if exists %I on %I', t || '_keep_archived', t);
    execute format(
      'create trigger %I before update on %I
         for each row execute function keep_archived_archived()',
      t || '_keep_archived', t);

    execute format('drop trigger if exists %I on %I', t || '_block_arch_del', t);
    execute format(
      'create trigger %I before delete on %I
         for each row execute function block_archived_delete()',
      t || '_block_arch_del', t);
  end loop;
end $$;

reset client_min_messages;

-- ── 8. Tracked revisions ────────────────────────────────────────────────────
--
-- Sheet-cased, because that is what STATE.rev is keyed by and what revCheck
-- must hand back. This row only gives the counter somewhere to live; what
-- actually makes a tab rev-tracked and part of readAll is membership of
-- STATE_KEY in the Edge Function (REV_TABS = Object.keys(STATE_KEY)).
insert into revs (tab, rev) values ('Duty', 1), ('Calendar', 1), ('OilRules', 1)
on conflict (tab) do nothing;
