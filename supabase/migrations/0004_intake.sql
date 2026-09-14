-- ============================================================================
-- 0004_intake.sql — surviving a change of intake
--
-- Every few months the company empties out and refills. Until now there was no
-- mechanism for that at all: the roster was simply retyped, and everything the
-- previous cohort generated either stayed and polluted the new one's numbers or
-- was deleted outright. Neither is acceptable for medical data.
--
-- THE PROBLEM, PRECISELY
-- ---------------------
-- A 4D is not a person. It is a SEAT. Digit 1 is the platoon and digit 2 the
-- section (js/helpers.js getPlt/getSect), so the 1101..4xxx range is reissued
-- whole to a new set of people every intake. Two consequences, and the second
-- is the one that bites:
--
--   * The same human coming back (recoursed, back-squadded, deferred) returns
--     under a DIFFERENT 4D, so their medical and injury history is stranded
--     under the old one.
--   * `roster.id` IS the 4D and it is the PRIMARY KEY (0001). Last intake's
--     1101 and this intake's 1101 are different people competing for one row.
--     There is no way to keep both without re-keying one of them.
--
-- THE MODEL
-- ---------
-- Three ideas, and everything below is an expression of one of them.
--
-- 1. `people` — a permanent registry, one row per human, keyed by a `pid` that
--    never changes. The 4D stays the join key everywhere in the app (no
--    refactor of 9.8k lines of frontend); `pid` exists so that recognising a
--    returning face is an id lookup instead of a name guess. The first
--    changeover has to match on names because that is all we have; every
--    changeover after it matches on pid, exactly.
--
-- 2. `intake` — a label stamped on every cohort-scoped row. Combined with the
--    `deleted_at` that already exists, archiving becomes a stamp rather than a
--    copy: the rows stay in Postgres, stay indexed, stay queryable forever, and
--    simply stop being visible to the app (every read in the Edge Function is
--    `where deleted_at is null`). Nothing is exported, nothing is deleted, and
--    "restore last intake" is an UPDATE.
--
-- 3. Archived rows are re-keyed, not moved. An outgoing roster row's id becomes
--    `1101@25-08` (archive_key), which frees `1101` for the incoming cohort and
--    keeps the archived row joinable to its own children, whose `d4` is
--    re-keyed to match. History stays internally consistent; it just moves out
--    of the live namespace.
--
-- WHAT PROTECTS IT
-- ----------------
-- A phone that still holds the previous cohort in localStorage is the main
-- threat to all of this, and it has two ways in. Both are closed here in SQL,
-- so the guarantee does not depend on redeploying the Edge Function:
--
--   * upsertOne sets `deleted_at = null` on every write, so a stale full-tab
--     push would REVIVE the entire previous cohort. `keep_archived_archived`
--     refuses that silently — see the trigger for why silently.
--   * writeWholeTab HARD-deletes MSK (it has no `id`), which would destroy
--     archived injury history outright. `block_archived_delete` skips it.
--
-- `pid` and `intake` are also added to dropped_fields, which the Edge Function
-- already consults on every write (shapeRow). That makes them server-owned:
-- readable by the client, never writable by it, so no client can invent a pid
-- or move someone between intakes.
--
-- Additive and safe over populated tables, like 0003. Existing rows are stamped
-- with the bootstrap intake; nothing is rewritten.
-- ============================================================================

-- ── 1. The intake register ──────────────────────────────────────────────────

create table if not exists intakes (
  label       text primary key,
  cutoff_date date        not null,          -- the new cohort's first day
  is_current  boolean     not null default false,
  applied_at  timestamptz not null default now(),
  roll_rows   integer,
  recruits    integer,
  returnees   integer,
  note        text
);

comment on table intakes is
  'One row per cohort. `label` is stamped on every cohort-scoped row; the '
  'current one is what the app sees.';

-- Exactly one current intake, enforced rather than merely intended.
create unique index if not exists intakes_one_current_idx
  on intakes (is_current) where is_current;

-- `stable`, not `immutable`: it reads a table. That is also why it cannot be
-- used in an index predicate, only in defaults and trigger bodies.
create or replace function current_intake() returns text
  language sql stable
  set search_path = public
as $$ select label from intakes where is_current limit 1 $$;

-- Bootstrap. Everything that exists right now belongs to the cohort in camp
-- today; it has no real label yet, so it gets a placeholder the first real
-- migration will rename. cutoff_date is deliberately the epoch — this intake
-- was never "started" by this system.
insert into intakes (label, cutoff_date, is_current, note)
values ('bootstrap', date '1970-01-01', true,
        'Pre-existing data, stamped when 0004 was applied. Renamed by the first real changeover.')
on conflict (label) do nothing;

-- ── 2. The people registry ──────────────────────────────────────────────────

create table if not exists people (
  pid          text primary key,
  name         text not null,
  name_key     text not null,     -- order-independent token set; see person_name_key
  nric_hash    text,              -- digest only, NEVER the value. See below.
  first_intake text,
  last_intake  text,
  last_d4      text,              -- the 4D they currently hold, if any
  d4_history   text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- NRIC IS NEVER STORED, only a digest of the last-4-plus-checksum, and only
-- when the nominal roll happens to carry it. It exists for one purpose: to make
-- returnee matching exact instead of a name comparison.
--
-- The digest is keyed with a secret (COUGAR_ENC_KEY, the same one 0002 uses for
-- column encryption) and never computed in the database. An unkeyed hash would
-- be worthless here: the space of NRIC suffixes is about 260,000 values, so a
-- plain SHA-256 of one is walked offline in under a second and the digest IS
-- the value. Keyed, and with the key held only in the function environment, a
-- database dump yields nothing.
comment on column people.nric_hash is
  'Keyed digest of the NRIC last-4+checksum, computed client-side by '
  'scripts/intake-migrate.mjs. Never the raw value; never derivable without '
  'COUGAR_ENC_KEY.';

comment on column people.d4_history is
  'Every 4D this person has ever held, oldest first. The audit trail for a '
  'recoursee whose records moved seats.';

create index if not exists people_name_key_idx on people (name_key);
create index if not exists people_last_d4_idx  on people (last_d4);
create unique index if not exists people_nric_hash_idx
  on people (nric_hash) where nric_hash is not null;

-- CREATE TRIGGER has no IF NOT EXISTS, and everything else in this migration is
-- re-runnable, so drop first rather than make one statement the reason a rerun
-- fails halfway through.
drop trigger if exists people_touch on people;
create trigger people_touch before update on people
  for each row execute function touch_updated_at();

-- Order-independent identity key for a name, mirroring intakeNameKey in
-- scripts/intake-plan.mjs. Both exist because matching happens in the script
-- but ad-hoc "who is this" queries happen in SQL, and the two must agree.
--
-- Sorting the tokens is the load-bearing part. The same person is recorded as
-- "TAN WEI MING" in one system and "WEI MING TAN" in another; a sorted token
-- set collapses both to one key. Particles that carry no identifying
-- information (bin, binte, s/o, d/o) are dropped so "MUHAMMAD BIN ALI" and
-- "MUHAMMAD B ALI" agree.
create or replace function person_name_key(p_name text) returns text
  language sql immutable
  set search_path = public
as $$
  select coalesce(
    (select string_agg(t, ' ' order by t)
       from (
         select distinct tok as t
           from unnest(string_to_array(
                  regexp_replace(lower(coalesce(p_name, '')), '[^a-z]+', ' ', 'g'),
                  ' ')) as tok
          where length(tok) >= 2
            and tok <> all (array['bin','binte','binti','bte','so','do','al','ap'])
       ) s),
    '')
$$;

-- ── 3. The changeover log ───────────────────────────────────────────────────
--
-- One row per person whose records were moved from one seat to another. This is
-- the answer to "why does this recruit have an IPPT from before he enlisted" —
-- without it, a re-homed record is indistinguishable from a data-entry error.
create table if not exists intake_log (
  id         bigserial primary key,
  at         timestamptz not null default now(),
  -- ON UPDATE CASCADE because the first changeover RENAMES 'bootstrap' to the
  -- outgoing cohort's real label (intake-migrate.mjs) — the operator knows what
  -- the company in camp today is called; this migration does not.
  intake     text not null references intakes (label) on update cascade,
  pid        text references people (pid),
  name       text,
  old_d4     text,
  new_d4     text,
  matched_by text,              -- pid | nric | name | fuzzy | override
  rows_moved jsonb not null default '{}'::jsonb   -- {"medical": 4, "msk": 2, ...}
);

create index if not exists intake_log_intake_idx on intake_log (intake);
create index if not exists intake_log_pid_idx    on intake_log (pid);

-- ── 4. Stamp every cohort-scoped table ──────────────────────────────────────
--
-- Conducts is excluded on purpose: it is a vocabulary of conduct NAMES
-- ("Orientation Run"), which recur every intake. Re-creating it each time would
-- orphan the conductId references in the archive for no gain.
--
-- The column DEFAULT means every ordinary write from here on stamps itself with
-- the current intake, with no Edge Function change and no client change.
do $$
declare t text;
begin
  foreach t in array array[
    'roster','medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk'
  ] loop
    execute format(
      'alter table %I add column if not exists intake text default current_intake()', t);
    execute format(
      'update %I set intake = current_intake() where intake is null', t);
    execute format(
      'create index if not exists %I on %I (intake) where deleted_at is null',
      t || '_intake_idx', t);
  end loop;
end $$;

-- `pid` lives on roster as well as in people. Denormalised deliberately: the
-- app joins everything through the 4D, and a roster row that cannot name its
-- own person is one join away from every question worth asking.
alter table roster add column if not exists pid text references people (pid);
create index if not exists roster_pid_idx on roster (pid);

-- Server-owned: readable by the client (api_row returns every non-bookkeeping
-- column), never writable by it. shapeRow in the Edge Function drops these on
-- the way in, so a stale phone cannot reassign an identity or move someone
-- between cohorts by pushing its cache.
--
-- NOTE the Edge Function caches dropped_fields in a module-level `DENIED` for
-- the life of a warm instance, so these take effect on the next cold start.
-- Redeploy the function after applying this migration rather than waiting.
insert into dropped_fields (tab, field, reason) values
  ('Roster', 'pid',    'server-owned identity; assigned only by intake-migrate.mjs'),
  ('Roster', 'intake', 'server-owned cohort stamp; assigned only by intake-migrate.mjs')
on conflict (tab, field) do nothing;

-- ── 5. Archive keys ─────────────────────────────────────────────────────────
--
-- Frees a 4D for the incoming cohort without destroying the outgoing one.
-- "1101" + "25/08" -> "1101@25-08".
--
-- The separator has to be something padD4 (js/state.js) will not mangle and a
-- real 4D can never contain. "@" qualifies: padD4 only strips a leading "C" and
-- pads pure 1-3 digit values, so an archive key passes through it unchanged.
-- The label's own "/" is flattened to "-" so the key stays one path-safe token.
create or replace function archive_key(p_d4 text, p_intake text) returns text
  language sql immutable
  set search_path = public
as $$
  select case
    when coalesce(p_d4, '') = '' then p_d4
    when p_d4 like '%@%' then p_d4        -- already archived; never double-stamp
    else p_d4 || '@' || replace(coalesce(p_intake, 'unknown'), '/', '-')
  end
$$;

-- ── 6. Two guards against a stale device ────────────────────────────────────
--
-- Both defend the same invariant — ONCE ARCHIVED, ALWAYS ARCHIVED — against the
-- two code paths in the Edge Function that would otherwise break it. Neither
-- path is wrong for live data; they simply predate the existence of archived
-- data, and fixing them here means the invariant holds even against a function
-- deployment that has not been updated.

-- upsertOne ends with `deleted_at = null` so that a delete-then-append revives
-- the tombstone (index.ts, appendOne's comment). Correct within one cohort;
-- catastrophic across a changeover, where a phone still holding the previous
-- intake in localStorage would push its whole cache and resurrect 280 people.
--
-- This SILENTLY keeps the row archived rather than raising. An exception would
-- abort the surrounding transaction, and js/sync.js would retry it forever —
-- so a single stale phone could lock every device out of writing. The write it
-- is refusing is a write of data the client should no longer have at all, so
-- dropping it loses nothing; the client heals on its next pull.
create or replace function keep_archived_archived() returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if old.deleted_at is not null
     and new.deleted_at is null
     and old.intake is distinct from current_intake()
  then
    new.deleted_at := old.deleted_at;
    new.intake     := old.intake;
  end if;
  return new;
end $$;

-- writeWholeTab hard-deletes MSK before reinserting, because MSK has no `id`
-- to diff on (0001's note). Archived injury history would go with it — the one
-- place in this schema where a stale client could destroy data outright rather
-- than merely hide it. Returning NULL from a BEFORE DELETE trigger skips the
-- delete for that row and lets the rest proceed.
create or replace function block_archived_delete() returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if old.deleted_at is not null
     and old.intake is distinct from current_intake()
  then
    return null;
  end if;
  return old;
end $$;

-- `drop trigger if exists` emits a NOTICE per trigger that was not there, which
-- on a first run is 22 lines of noise ahead of the only output that matters.
set client_min_messages = warning;

do $$
declare t text;
begin
  foreach t in array array[
    'roster','medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk'
  ] loop
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

-- ── 7. Reading the archive ──────────────────────────────────────────────────
--
-- The point of stamping instead of exporting: history is a WHERE clause.
--   select * from medical where intake = '25/08';
--   select * from roster  where intake = '25/08' and deleted_at is not null;
--
-- This view answers the question that actually gets asked — "what has this
-- person done across every intake they have been in" — which is otherwise a
-- five-way join through d4_history that nobody will write correctly at 2am.
create or replace view person_history as
  select p.pid,
         p.name,
         p.first_intake,
         p.last_intake,
         p.last_d4,
         p.d4_history,
         array_length(p.d4_history, 1) as seats_held,
         r.intake      as current_intake,
         r."id"        as current_d4,
         r."rank"      as current_rank
    from people p
    left join roster r
      on r."id" = p.last_d4
     and r.deleted_at is null;

comment on view person_history is
  'One row per known person with the seats they have held. seats_held > 1 '
  'means a returnee: their records were re-homed by a changeover, and '
  'intake_log says when and from where.';

alter table intakes    enable row level security;
alter table people     enable row level security;
alter table intake_log enable row level security;
