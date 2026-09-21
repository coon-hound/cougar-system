-- ============================================================================
-- 0007_departures.sql - make an archive survive the retention purge.
--
-- 0004 established what archiving means here: a row is RE-KEYED out of the
-- live 4D namespace ("1101" -> "1101@25-08") and soft-deleted. It stays in
-- Postgres, stays indexed, stays joined to its own children, and simply stops
-- being visible to the app. Nothing is exported and nothing is destroyed.
--
-- 0002 predates that, and it disagrees. purge_retention() hard-deletes every
-- roster row soft-deleted longer ago than the window, plus every child row
-- keyed on its 4D, and it has no idea what an archive key is. As things stand
-- the whole archived `bmt` cohort - 256 men and every medical, IPPT and MSK
-- row they generated - becomes purgeable 90 days after the changeover that
-- archived them. The archive is not durable; it is merely hidden, on a fuse.
--
-- That gap was survivable while a change of intake was the only thing that
-- archived anybody, because nobody runs the purge on the day. It stops being
-- survivable now that a SINGLE MAN can be archived mid-intake by
-- scripts/depart.mjs: his rows carry the CURRENT intake label, so the two
-- guards 0004 installed - both of which test `intake is distinct from
-- current_intake()` - do not recognise him as archived at all.
--
-- So this migration makes ONE idea explicit everywhere: a row whose key
-- carries an "@" is archived, whatever cohort it belongs to.
--
--   * archive_key_of()          - the key, whichever column holds it
--   * keep_archived_archived()  - also fires on an archive key
--   * block_archived_delete()   - also fires on an archive key
--   * purge_retention()         - never touches an archived row, and says how
--                                 many it skipped
--
-- Additive and re-runnable. It creates no table and rewrites no row.
-- ============================================================================

-- ── 1. Which column holds the archive key ───────────────────────────────────
--
-- The two guards below are installed on eleven tables with two different key
-- columns: roster's key IS its `id`, every child table's is `d4`. The trigger
-- functions are shared, so they read the row as jsonb rather than carrying a
-- column name per table.
--
-- THE COALESCE ORDER IS LOAD-BEARING. `medical` has BOTH an `id` (a random,
-- meaningless row id - see the note in the migration log about ids never having
-- been a key in the live data) and a `d4`. Only the d4 is ever archive-keyed,
-- so d4 must win. Roster has no `d4` column at all - its display form is "4d" -
-- so it falls through to `id`, which is what we want there.
create or replace function archive_key_of(p_row jsonb) returns text
  language sql immutable
  set search_path = public
as $$ select coalesce(p_row->>'d4', p_row->>'id') $$;

comment on function archive_key_of(jsonb) is
  'The archive-keyed column of a row, as text: d4 for a child table, id for '
  'roster. An "@" in the result means the row has been archived.';

-- ── 2. Both 0004 guards learn about the archive key ─────────────────────────
--
-- Unchanged in intent, and still SILENT rather than raising: an exception here
-- aborts the surrounding transaction and js/sync.js would retry it forever, so
-- one stale phone could lock every device out of writing. The write being
-- refused is a write of data the client should no longer hold at all.
create or replace function keep_archived_archived() returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if old.deleted_at is not null
     and new.deleted_at is null
     and (old.intake is distinct from current_intake()
          or coalesce(archive_key_of(to_jsonb(old)), '') like '%@%')
  then
    new.deleted_at := old.deleted_at;
    new.intake     := old.intake;
  end if;
  return new;
end $$;

create or replace function block_archived_delete() returns trigger
  language plpgsql
  set search_path = public
as $$
begin
  if old.deleted_at is not null
     and (old.intake is distinct from current_intake()
          or coalesce(archive_key_of(to_jsonb(old)), '') like '%@%')
  then
    return null;
  end if;
  return old;
end $$;

-- The triggers themselves were installed by 0004 on all eleven tables and are
-- bound to the function by name, so replacing the bodies above is the whole
-- change. Nothing to re-create here.

-- ── 3. The purge stops eating the archive ───────────────────────────────────
--
-- Same shape, same dry-run-by-default contract, same return value plus one new
-- key: `archived_skipped`, so an operator can see that the archive was seen and
-- deliberately left alone rather than silently missed.
--
-- A row is out of reach of the purge if EITHER
--   * its key carries an "@" (it was archived), or
--   * it is stamped with an intake that is not the current one (it belongs to
--     a cohort that has left).
-- Tables with no `intake` column read as the current intake and stay
-- purgeable, which is right: conducts and paradestates are not cohort-scoped.
create or replace function purge_retention(
  p_commit             boolean default false,
  p_soft_delete_days   integer default 90,
  p_snapshot_days      integer default 365,
  p_audit_days         integer default 730
) returns jsonb language plpgsql
  set search_path = public
as $$
declare
  result   jsonb := '{}'::jsonb;
  n        bigint;
  t        text;
  gone     text[];
  child    text;
  skipped  bigint;
  -- Every LIKE pattern below is going through format(), so its % must be
  -- doubled. Writing it once here is less fragile than remembering to escape
  -- it at four call sites.
  keep_live constant text :=
    'coalesce(archive_key_of(to_jsonb(t)), '''') not like ''%%@%%''
     and coalesce(to_jsonb(t)->>''intake'', current_intake())
         is not distinct from current_intake()';
begin
  -- 1. Roster rows soft-deleted longer ago than the window, EXCLUDING anyone
  --    who was archived. An archived man's roster row is soft-deleted by
  --    definition - that is how archiving works - so without this the purge
  --    reads an archive as a 90-day-old deletion and destroys it along with
  --    every child row it can find.
  select array_agg("id") into gone
    from roster
   where deleted_at is not null
     and deleted_at < now() - make_interval(days => p_soft_delete_days)
     and "id" not like '%@%'
     and intake is not distinct from current_intake();
  gone := coalesce(gone, '{}');
  result := result || jsonb_build_object('roster', cardinality(gone));

  select count(*) into skipped
    from roster
   where deleted_at is not null
     and ("id" like '%@%' or intake is distinct from current_intake());
  result := result || jsonb_build_object('archived_skipped', skipped);

  -- 2. Their records in every d4-keyed child table.
  foreach child in array array[
    'medical','ippt','routemarch','soc','polarflow','conductdetail',
    'appointments','leave','msk','reportsick','tgusers'
  ] loop
    execute format('select count(*) from %I where "d4" = any($1)', child)
      into n using gone;
    result := result || jsonb_build_object(child, n);
    if p_commit and cardinality(gone) > 0 then
      execute format('delete from %I where "d4" = any($1)', child) using gone;
    end if;
  end loop;

  if p_commit and cardinality(gone) > 0 then
    delete from roster where "id" = any(gone);
  end if;

  -- 3. Soft-deleted rows in every other table, past the same window - again
  --    never an archived one. This is the second way the archive used to die:
  --    an archived cohort's medical rows are soft-deleted too, and this loop
  --    does not go anywhere near the roster to find that out.
  foreach t in array array[
    'medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk','conducts',
    'paradestates','tgusers','reportsick'
  ] loop
    execute format(
      'select count(*) from %I t where t.deleted_at is not null
         and t.deleted_at < now() - make_interval(days => $1) and %s', t, keep_live)
      into n using p_soft_delete_days;
    result := result || jsonb_build_object(t || '_soft_deleted', n);
    if p_commit then
      execute format(
        'delete from %I t where t.deleted_at is not null
           and t.deleted_at < now() - make_interval(days => $1) and %s', t, keep_live)
        using p_soft_delete_days;
    end if;
  end loop;

  -- 4. Parade snapshots. savedAt is epoch milliseconds held as text, so the
  --    cast is guarded and falls back to the row's own insert time.
  select count(*) into n from paradestates
   where (case when "savedAt" ~ '^\d+$'
               then to_timestamp(("savedAt")::bigint / 1000.0)
               else updated_at end) < now() - make_interval(days => p_snapshot_days);
  result := result || jsonb_build_object('paradestates_aged', n);
  if p_commit then
    delete from paradestates
     where (case when "savedAt" ~ '^\d+$'
                 then to_timestamp(("savedAt")::bigint / 1000.0)
                 else updated_at end) < now() - make_interval(days => p_snapshot_days);
  end if;

  -- 5. Audit trim.
  select count(*) into n from audit where at < now() - make_interval(days => p_audit_days);
  result := result || jsonb_build_object('audit', n);
  if p_commit then
    delete from audit where at < now() - make_interval(days => p_audit_days);
  end if;

  return result || jsonb_build_object('committed', p_commit);
end $$;

-- ── 4. A departure needs somewhere to say why ───────────────────────────────
--
-- intake_log already records one row per man whose records moved from one seat
-- to another, which is exactly what a departure is. The one thing it cannot
-- record is the reason, and "posted out to 46 SAR" is the difference between a
-- log entry and an answer.
alter table intake_log add column if not exists note text;

comment on column intake_log.note is
  'Free text from the operator: why this move happened. Written by '
  'scripts/depart.mjs from --reason; null everywhere else.';
