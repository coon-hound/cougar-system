-- ============================================================================
-- 0005_usage.sql — usage telemetry
--
-- We want evidence, not opinion, about what belongs at the top of the
-- dashboard. Two questions drive everything here:
--
--   1. what do people actually open?   (feature access frequency, view dwell)
--   2. what costs them the most taps?  (clicks per task, abandonment rate)
--
-- See TELEMETRY-DESIGN.md for the client half.
--
-- ROLLED-UP COUNTERS, NOT RAW EVENTS — the one real design decision
-- ------------------------------------------------------------------
-- Every question above is an aggregate. None of them needs to know that a
-- particular tap happened at 14:07:13; they need sums per feature per day.
-- Storing raw events would mean a few hundred rows per device per day —
-- roughly 100k rows a week across the company — to answer questions that a
-- GROUP BY over a few hundred counter rows answers exactly as well.
--
-- Three further reasons, and the second is the one that settles it:
--
--   * BOUNDED SIZE. Rows here are O(days x devices x distinct names), not
--     O(taps). ~30 devices x ~30 days x ~60 names is a ceiling around 54k rows
--     ever, and `usage_prune` keeps even that from growing without limit.
--   * PRIVACY BY CONSTRUCTION. A counter row is (day, device, kind, name,
--     integers). There is nowhere for a 4D, a name, a medical tag or a
--     free-text reason to live even if the client scrub were to fail. This app
--     holds medical records for real soldiers (CLAUDE.md); the storage shape
--     should not depend on client-side discipline alone.
--   * IT MATCHES THE CLIENT. telemetry.js already keeps pre-aggregated
--     counters so the local read-out is cheap and survives buffer pruning. The
--     flush is therefore a delta of those same counters, and the server is an
--     accumulator — no reshaping on either side.
--
-- What is given up: per-session sequences ("which path did they take through
-- the wizard"). That is a different question from the one the product owner
-- asked, and raw events can be added later as a second table without touching
-- this one.
--
-- ADDITIVE UPSERT NEEDS REPLAY PROTECTION
-- ---------------------------------------
-- A delta applied twice is wrong in a way a full-state write never is, and the
-- client flushes over mobile data with `navigator.sendBeacon`, where the
-- outcome is unknowable. So each flush carries a `batch_id`: the server
-- records it first, and a redelivered batch is a primary-key conflict that
-- short-circuits before any counter moves.
--
-- DELIBERATELY OUTSIDE THE SYNC MACHINERY
-- ---------------------------------------
-- No row in `revs`, not in REV_TABS, not in TABLE, not in readAll, not in the
-- pull cycle. This is the single most important constraint in the feature. The
-- existing machinery is built for small, hand-edited, bidirectionally-synced
-- tables: every write bumps that tab's rev and every other open phone polls
-- revCheck on a 20-second timer and pulls what changed. Put an append-only
-- usage stream behind that and each recorded click makes every device in the
-- company pull, on mobile data, for data no client's UI is even reading.
-- Analytics must not degrade the app it is measuring.
--
-- COLUMN TYPES ARE REAL TYPES HERE
-- --------------------------------
-- 0001 types every data column `text` so API responses stay byte-identical to
-- what the Sheets backend produced. That reason does not apply to this table:
-- it never existed in Sheets, it is never returned by `api_row`, and nothing in
-- js/state.js normalises it. Counters that are summed and compared should be
-- `bigint`, and a day that is range-scanned should be `date`.
--
-- SOFT DELETE IS OMITTED, ALSO DELIBERATELY
-- -----------------------------------------
-- Every other table carries `deleted_at` / `extra` / `api_row` because rows
-- there are records a human edits and may need back. A counter is neither
-- edited nor recoverable-by-request; it ages out. `usage_prune` is the whole
-- lifecycle. `updated_at` is kept, with the same trigger as everywhere else,
-- because "when did this counter last move" is genuinely useful.
-- ============================================================================

-- ── 1. The counter table ────────────────────────────────────────────────────
--
-- kind:
--   'feature'  a click resolved to an inline-handler function name.
--              events = clicks. Answers "what do people actually open".
--   'view'     a STATE.nav view that was left.
--              events = times entered, ms = total dwell. avg dwell = ms/events.
--   'task'     a named funnel (book out, log leave, …).
--              events = starts, completed/abandoned = how they ended,
--              clicks = total taps spent across ended sessions, ms = duration.
--              clicks/(completed+abandoned) is the clicks-per-task figure, and
--              abandoned/(completed+abandoned) the abandonment rate.
--
-- `name` is a function name, a nav key or a task key — never data. The client
-- strips any run of two or more digits before recording, and the Edge Function
-- strips them again on the way in, because a 4D is four digits and a 4D must
-- never reach this table.
create table usage_daily (
  _pk        bigserial   primary key,
  day        date        not null,
  device     text        not null,   -- pseudonymous: a short hash of the device
                                     -- token, NEVER the token itself, which is
                                     -- a live credential (0001 auth_tokens).
  kind       text        not null check (kind in ('feature', 'view', 'task')),
  name       text        not null check (name <> '' and length(name) <= 48),
  events     bigint      not null default 0 check (events    >= 0),
  completed  bigint      not null default 0 check (completed >= 0),
  abandoned  bigint      not null default 0 check (abandoned >= 0),
  clicks     bigint      not null default 0 check (clicks    >= 0),
  ms         bigint      not null default 0 check (ms        >= 0),
  updated_at timestamptz not null default now(),
  unique (day, device, kind, name)
);

comment on table usage_daily is
  'Pre-aggregated usage counters, one row per (day, device, kind, name). '
  'Deliberately outside REV_TABS / readAll / the pull cycle — see the header '
  'of 0005_usage.sql. Holds no personal data by construction.';

-- ── 2. Replay protection for the additive upsert ────────────────────────────
--
-- Recorded BEFORE the counters move, in the same transaction, so a redelivered
-- batch conflicts on the primary key and the counters are left alone.
create table usage_batches (
  batch_id   text        primary key,
  device     text        not null,
  rows_count integer     not null default 0,
  at         timestamptz not null default now()
);

comment on table usage_batches is
  'One row per accepted flush. Makes the additive upsert into usage_daily '
  'idempotent: a beacon whose response was never seen can be retried safely.';

-- ── 3. Indexes, shaped by the four questions ────────────────────────────────
--
-- The unique (day, device, kind, name) index already serves the upsert and any
-- single-device read. These cover the other two access patterns:
--
--   company-wide, one kind, recent window:
--     select name, sum(events) from usage_daily
--      where kind = 'task' and day >= current_date - 7 group by name;
--   one device's whole history (the "this device" toggle):
--     select * from usage_daily where device = $1 and day >= $2;
create index usage_daily_kind_day_idx on usage_daily (kind, day desc);
create index usage_daily_device_day_idx on usage_daily (device, day desc);
create index usage_batches_at_idx on usage_batches (at desc);

-- ── 4. updated_at + RLS, exactly as every other table ───────────────────────
--
-- RLS on with NO POLICIES: the anon and authenticated roles can read nothing.
-- All access is through the Edge Function on the service role, which bypasses
-- RLS by role attribute — the single intended access path (0001).
create trigger usage_daily_touch before update on usage_daily
  for each row execute function touch_updated_at();

alter table usage_daily   enable row level security;
alter table usage_batches enable row level security;

-- ── 5. Retention ────────────────────────────────────────────────────────────
--
-- Nothing here is worth keeping forever: a decision about dashboard layout is
-- made from the last few weeks, not the last few years. Called on demand (or
-- from pg_cron if this ever needs to be automatic — deliberately not scheduled
-- here, so the first prune is a decision someone makes).
create or replace function usage_prune(p_days integer default 90)
  returns table (daily_deleted bigint, batches_deleted bigint)
  language plpgsql as $$
declare d bigint; b bigint;
begin
  delete from usage_daily where day < current_date - p_days;
  get diagnostics d = row_count;
  -- Batch ids only need to outlive the client's retry window, which is hours,
  -- not months; 30 days is generous and keeps the table trivially small.
  delete from usage_batches where at < now() - interval '30 days';
  get diagnostics b = row_count;
  return query select d, b;
end $$;

comment on function usage_prune is
  'Ages out usage counters older than p_days and spent batch ids. Safe to run '
  'repeatedly; not scheduled by this migration on purpose.';

-- ── 6. The read-out ─────────────────────────────────────────────────────────
--
-- The insights view asks exactly one shape of question, so it lives here
-- rather than as ad-hoc SQL in the Edge Function: given a window and either
-- one device or everybody, return the counters folded across devices.
--
-- `p_device = null` means company-wide. Folding happens in SQL so the response
-- over mobile data is the size of the answer, not the size of the table.
create or replace function usage_rollup(p_days integer default 14, p_device text default null)
  returns table (
    day        date,
    kind       text,
    name       text,
    events     bigint,
    completed  bigint,
    abandoned  bigint,
    clicks     bigint,
    ms         bigint
  )
  language sql stable as $$
    select u.day, u.kind, u.name,
           sum(u.events)::bigint,
           sum(u.completed)::bigint,
           sum(u.abandoned)::bigint,
           sum(u.clicks)::bigint,
           sum(u.ms)::bigint
      from usage_daily u
     where u.day >= current_date - greatest(coalesce(p_days, 14), 0)
       and (p_device is null or u.device = p_device)
     group by u.day, u.kind, u.name
$$;

comment on function usage_rollup is
  'Windowed counters for the insights view. p_device null = company-wide, '
  'otherwise that one pseudonymous device id.';

-- ── 7. NOT registered in `revs`, on purpose ─────────────────────────────────
--
-- If you are here because you were about to add ('Usage', 1) to `revs`: do not.
-- It would put this table into revCheck, and every recorded click would then
-- wake every phone in the company for a pull of data no client's UI reads.
-- The header of this file explains it in full. The client flushes through the
-- dedicated `usageAppend` action and reads through `usageRead`, both of which
-- bypass withRev entirely in supabase/functions/api/index.ts.
