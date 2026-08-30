-- ============================================================================
-- 0001_init.sql — Cougar system: Google Sheets → Postgres
--
-- Phase 1 of the backend migration. Creates one table per Sheet tab, the
-- revision counters that back optimistic concurrency, and the auth/invite
-- tables that replace ScriptProperties.
--
-- TWO DELIBERATE DESIGN CHOICES, both load-bearing:
--
-- 1. EVERY DATA COLUMN IS `text`.
--    Dates currently travel the wire as display strings ("16 May 2026",
--    apps-script-Code.gs:781) and the frontend parses that format. Storing
--    text guarantees byte-identical API responses, which makes the parity
--    test a straight diff and removes the largest cutover risk. Real
--    date/int/bool types are a follow-up migration once cutover is proven.
--
-- 2. COLUMN NAMES MATCH THE SHEET HEADERS EXACTLY, including "4d" and
--    "highest education level". They are ugly to type, but they let the Edge
--    Function do `select api_row(to_jsonb(t)) from roster t` and return rows
--    with zero key mapping — no translation layer means no translation bugs.
--
-- Headers are taken from the LIVE workbook (cougar_fitness_tracker.xlsx), not
-- from the doc comment at apps-script-Code.gs:40-132, which has drifted: it
-- documents PolarFlow z1..z5/recovery that do not exist, and omits Roster's
-- campIn/groups/campInSince/location/locationSince, Medical's inCamp, and
-- ConductDetail's program.
-- ============================================================================

create extension if not exists pgcrypto;

-- ── Shared plumbing ─────────────────────────────────────────────────────────

-- Every table carries updated_at / deleted_at / extra. `api_row` strips the
-- bookkeeping columns and merges `extra` back up to the top level, so what the
-- client sees is exactly the key set the Sheet returned.
--
-- NULLS COLLAPSE TO "". Apps Script's getValues() (apps-script-Code.gs:747)
-- returns "" for an empty cell and never null, so every consumer in js/* was
-- written against "". A bare `to_jsonb(row)` would hand them null instead, and
-- the difference is not cosmetic: normalizeRoster (js/state.js:313) guards
-- leaveQuota with `!== "" ? +v : ""`, so a null slips through the guard and
-- becomes +null = 0 — an empty quota silently reads as a zero quota. Coalescing
-- here keeps the byte-identical-response promise this schema is built on, in
-- one place, rather than auditing every field access on the client.
create or replace function api_row(t jsonb) returns jsonb
  language sql immutable parallel safe as $$
    select coalesce(
             (select jsonb_object_agg(
                       key,
                       case when value = 'null'::jsonb then '""'::jsonb else value end)
                from jsonb_each((t - 'updated_at' - 'deleted_at' - 'extra' - '_pk')
                                || coalesce(t -> 'extra', '{}'::jsonb))),
             '{}'::jsonb)
$$;

create or replace function touch_updated_at() returns trigger
  language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ── Revision tracking (replaces ScriptProperties "rev:<Tab>") ────────────────
--
-- Fixes three bugs in the Apps Script version at once:
--   * revs lazily reseeded to 1 (:315), stranding clients that held higher
--     numbers — js/sync.js:901 only pulls when server > local;
--   * bumps lost to the unlocked onEdit read-modify-write fallback (:401);
--   * MSK rows arriving by Google Form, which bumped nothing at all.
-- A bigint in a row, bumped in the same transaction as the write it describes,
-- has none of those failure modes.
create table revs (
  tab text primary key,
  rev bigint not null default 1
);

create or replace function bump_rev(p_tab text) returns bigint
  language sql as $$
    insert into revs (tab, rev) values (p_tab, 2)
    on conflict (tab) do update set rev = revs.rev + 1
    returning rev
$$;

-- ── Roster ──────────────────────────────────────────────────────────────────
--
-- KEY SEMANTICS, verified against the live data — this is the subtlest part of
-- the whole migration:
--   * "4d"  holds the DISPLAY form, C-prefixed: "C1101".
--   * "id"  holds the CANONICAL key, digit-only: "1101". This is the column
--           the old backend matched on (findRowByIdIndex_ :982) and the column
--           every child table's `d4` actually joins to.
--   * normalizeRoster (js/state.js:293) computes padD4(id || "4d"), i.e. it
--     PREFERS "id" and only falls back to "4d" — so canonical wins.
--   * 26 of 282 live rows have an EMPTY "id" and are keyed off "4d" alone.
--     The importer must backfill id = padD4(id || "4d") for those, since the
--     primary key cannot be null.
--   * padD4 (js/state.js:284) strips a leading "C" and left-pads 1-3 digit
--     values to 4, so commander "1" becomes "0001" and survives the trip.
create table roster (
  "id"                         text primary key,   -- canonical padded 4D, e.g. "1101" / "0001"
  "4d"                         text,               -- display form, e.g. "C1101"
  "name"                       text,
  "age"                        text,
  "status"                     text,
  "notes"                      text,
  "phone"                      text,
  "email"                      text,
  "ration"                     text,
  "allergies"                  text,
  "msk"                        text,
  "highest education level"    text,
  "motorcycle license"         text,
  "height"                     text,
  "weight"                     text,
  "role"                       text,
  "rank"                       text,
  "leaveQuota"                 text,
  "outOfCamp"                  text,
  "outReason"                  text,
  "outSince"                   text,
  "dob"                        text,
  "bloodType"                  text,
  "otherMedical"               text,
  "nokName"                    text,
  "nokRelation"                text,
  "nokPhone"                   text,
  "address"                    text,
  "program"                    text,
  "campIn"                     text,
  "groups"                     text,
  "campInSince"                text,
  "location"                   text,
  "locationSince"              text,
  extra      jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- DATA MINIMISATION (plan §4.6): `gpa`, `fieldOfStudy`, `smoker` and
-- `nokOccupation` exist in the live sheet but are deliberately NOT created
-- here. They are display-only on the profile card (js/forms.js:106-125) and
-- drive no decision in the app. The importer must drop them, and the Edge
-- Function must deny-list them on write — otherwise they would simply
-- reaccumulate inside `extra`.

-- ── Child tables (all join to roster."id" via their own "d4") ────────────────
--
-- Note the source data types are inconsistent for the same logical key: IPPT
-- and PolarFlow hold d4 as a Sheets NUMBER (1101), Medical holds it as TEXT
-- (1203). Apps Script's getValues() coerces on read and padD4 normalises on
-- the client. The importer must pull through the live `readAll` endpoint (not
-- straight from the xlsx) so it inherits that same coercion.

create table medical (
  "id"         text primary key,
  "d4"         text,
  "date"       text,
  "reason"     text,
  "location"   text,
  "status"     text,
  "startDate"  text,
  "endDate"    text,
  "inCamp"     text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table attendance (
  "id"             text primary key,
  "date"           text,
  "total"          text,
  "participating"  text,
  "px"             text,
  "rsi"            text,      -- legacy column, still present in the live sheet
  "fallout"        text,
  "conductId"      text,
  "time"           text,
  "lms"            text,
  "remarks"        text,
  "program"        text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table ippt (
  "id"       text primary key,
  "d4"       text,
  "attempt"  text,
  "date"     text,
  "pushups"  text,
  "situps"   text,
  "runTime"  text,
  "score"    text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table routemarch (
  "id"     text primary key,
  "d4"     text,
  "rmNum"  text,
  "date"   text,
  "time"   text,
  "avgHr"  text,
  "maxHr"  text,
  "pass"   text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- SOC is listed in REV_TABS (apps-script-Code.gs:309) and in the readAllTabs
-- map, but NO SUCH TAB exists in the live workbook — readAllTabs silently
-- returns [] for it (:817-819). Created here so the revs/readAll contract
-- stays complete; expected to remain empty. Columns come from the doc comment,
-- as there is no live data to check them against.
create table soc (
  "id"      text primary key,
  "d4"      text,
  "socNum"  text,
  "date"    text,
  "time"    text,
  "avgHr"   text,
  "pass"    text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table polarflow (
  "id"            text primary key,
  "d4"            text,
  "date"          text,
  "avgHr"         text,
  "maxHr"         text,
  "minHr"         text,
  "calories"      text,
  "trainingLoad"  text,
  "duration"      text,
  "distance"      text,
  "conductId"     text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table conductdetail (
  "id"         text primary key,
  "date"       text,
  "time"       text,
  "d4"         text,
  "type"       text,
  "reason"     text,
  "conductId"  text,
  "program"    text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table appointments (
  "id"         text primary key,
  "d4"         text,
  "reason"     text,
  "date"       text,
  "time"       text,
  "location"   text,
  "resolved"   text,
  "outOfCamp"  text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table leave (
  "id"         text primary key,
  "d4"         text,
  "type"       text,
  "startDate"  text,
  "endDate"    text,
  "days"       text,
  "reason"     text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- MSK is the one tab with NO ROW IDENTITY: its live headers are
-- timestamp|d4|type|description|physioDate|exercises|cleared|manualRegions and
-- normalizeMSK (js/state.js:397-417) emits no `id` either. The old backend's
-- findRowByIdIndex_ therefore returns 0 for every MSK row, so id-based ops
-- silently no-op — which is why deleteEntry("msk", ...) (js/helpers.js:405)
-- never actually worked. Rows only ever arrive via a full-tab replace from
-- doPushAll (js/sync.js:842) or the Google Form.
--
-- So: a surrogate `_pk` gives the table a real primary key, and `api_row`
-- strips it, keeping responses byte-identical to today's.
create table msk (
  _pk              bigserial primary key,
  "timestamp"      text,
  "d4"             text,
  "type"           text,
  "description"    text,
  "physioDate"     text,
  "exercises"      text,
  "cleared"        text,
  "manualRegions"  text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table conducts (
  "id"    text primary key,
  "name"  text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Untracked tabs (outside REV_TABS / readAll, read on demand) ──────────────

-- Append-only archive of parade snapshots. `json` is a serialised blob that
-- was previously built around Sheets' 50k-chars-per-cell ceiling
-- (js/forms.js:2662) — a limit that does not exist here.
create table paradestates (
  "id"       text primary key,
  "type"     text,
  "savedAt"  text,
  "json"     text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Telegram bot tables. The bot stays in Apps Script (plan §5) but is rewired
-- to reach these through the API, so app and bot cannot diverge.
create table tgusers (
  "id"             text primary key,
  "chatId"         text,
  "userId"         text,
  "username"       text,
  "d4"             text,
  "name"           text,
  "role"           text,
  "sectionsOwned"  text,
  "registeredAt"   text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table reportsick (
  "id"          text primary key,
  "d4"          text,
  "name"        text,
  "plt"         text,
  "sect"        text,
  "context"     text,
  "reason"      text,
  "clinic"      text,
  "reportedAt"  text,
  "cutoffAt"    text,
  "bookInAt"    text,
  "status"      text,
  "startDate"   text,
  "endDate"     text,
  "mcUrl"       text,
  "state"       text,
  "notifiedSC"  text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- Single-row settings table; the check constraint keeps it that way.
create table config (
  _pk                smallint primary key default 1 check (_pk = 1),
  "botGroupChatId"   text,
  "nextBookInDate"   text,
  "nextBookInTime"   text,
  "outOfCamp"        text,
  "cutoffHours"      text,
  "rsoFormUrl"       text,
  extra jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

-- ── Auth (replaces the presence-check at apps-script-Code.gs:297) ────────────
--
-- The old model was a single ScriptProperty key per token: no identity, no
-- expiry, no revocation, no audit. Anyone holding any token could read and
-- write everything, forever, anonymously.
create table auth_tokens (
  token         text primary key,
  person        text,                                   -- who it was issued to
  device_label  text,                                   -- which device
  issued_at     timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '90 days',
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

create table invites (
  token        text primary key,
  max_uses     integer     not null default 1,
  used_count   integer     not null default 0,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  redemptions  jsonb       not null default '[]'::jsonb
);

-- ── Indexes ─────────────────────────────────────────────────────────────────
create index medical_d4_idx        on medical ("d4")        where deleted_at is null;
create index ippt_d4_idx           on ippt ("d4")           where deleted_at is null;
create index routemarch_d4_idx     on routemarch ("d4")     where deleted_at is null;
create index soc_d4_idx            on soc ("d4")            where deleted_at is null;
create index polarflow_d4_idx      on polarflow ("d4")      where deleted_at is null;
create index conductdetail_d4_idx  on conductdetail ("d4")  where deleted_at is null;
create index appointments_d4_idx   on appointments ("d4")   where deleted_at is null;
create index leave_d4_idx          on leave ("d4")          where deleted_at is null;
create index msk_d4_idx            on msk ("d4")            where deleted_at is null;
create index reportsick_d4_idx     on reportsick ("d4")     where deleted_at is null;
create index attendance_conduct_idx on attendance ("conductId") where deleted_at is null;

-- ── updated_at triggers + RLS ───────────────────────────────────────────────
--
-- RLS is enabled with NO POLICIES on every table, so the anon and authenticated
-- roles can read nothing at all. All access goes through the Edge Function
-- using the service role key, which bypasses RLS by role attribute — that is
-- the single intended access path. This preserves the invariant stated at
-- js/state.js:7 (the client is public code, so every authorization decision is
-- server-side), which matters more now that the repo itself is public.
--
-- Deliberately NOT using FORCE ROW LEVEL SECURITY: it would bind the table
-- owner too, buying nothing over the above while risking a maintenance
-- lockout from our own tables.
do $$
declare t text;
begin
  foreach t in array array[
    'roster','medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk','conducts',
    'paradestates','tgusers','reportsick','config',
    'revs','auth_tokens','invites'
  ] loop
    execute format('alter table %I enable row level security', t);
    if t not in ('revs','auth_tokens','invites') then
      execute format(
        'create trigger %I before update on %I
           for each row execute function touch_updated_at()',
        t || '_touch', t);
    end if;
  end loop;
end $$;

-- ── Seed the tracked revisions ──────────────────────────────────────────────
-- Exactly the 12 tabs in REV_TABS (apps-script-Code.gs:309-310), matching
-- TAB_TO_STATE (js/state.js:32-45). Sheet-cased names, because that is what
-- the client keys STATE.rev by and what revCheck must return.
insert into revs (tab, rev) values
  ('Roster', 1), ('Medical', 1), ('Attendance', 1), ('IPPT', 1),
  ('RouteMarch', 1), ('SOC', 1), ('PolarFlow', 1), ('ConductDetail', 1),
  ('Appointments', 1), ('Leave', 1), ('MSK', 1), ('Conducts', 1)
on conflict (tab) do nothing;
