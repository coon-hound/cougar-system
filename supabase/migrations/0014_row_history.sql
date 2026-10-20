-- ============================================================================
-- 0014_row_history.sql - a backup of every row, on every change
--
-- THE PROBLEM
-- -----------
-- When a record goes bad there has been nothing to put back. The audit trail
-- (0003) records what changed, but it was built to be read, not restored from:
--
--   * it is written by the Edge Function, so a change made any other way - a
--     script, the SQL editor, purge_retention, a migration - is not in it;
--   * the encrypted roster columns are '[redacted]' in it by design, so a
--     corrupted date of birth or next-of-kin record cannot be recovered from it;
--   * a full-tab `write` of MSK hard-deletes every row, and nothing kept them.
--
-- THE MECHANISM
-- -------------
-- A trigger on every data table copies the row as it stood BEFORE each insert,
-- update, delete and truncate into `row_history`. Because it is a trigger, no
-- write path can skip it, including ones not written yet.
--
-- Encrypted columns are copied as the ciphertext they already are. That is
-- exactly the protection the live table gives them, nothing is decrypted, and
-- it is what makes a full restore possible at all.
--
-- One pre-image per change is enough to rebuild any earlier state: the first
-- history entry for a row after time T holds what that row was at T, and an
-- entry with no pre-image means the row did not exist yet.
--
-- PUTTING IT BACK
-- ---------------
--   select restore_as_of('medical', '2026-10-20 09:00+08');            -- dry run
--   select restore_as_of('medical', '2026-10-20 09:00+08', true);      -- do it
--   select restore_as_of('medical', '2026-10-20 09:00+08', true,
--                        array['{"id":"mdq1-ab12-3"}'::jsonb]);         -- one row
--   select restore_all_as_of('2026-10-20 09:00+08', true);             -- everything
--
-- A restore is itself a change, so it lands in row_history and can be undone
-- the same way. It bumps the tab's rev so every phone pulls the restored data.
-- ============================================================================

create table if not exists row_history (
  id       bigserial primary key,
  at       timestamptz not null default now(),   -- transaction start: one edit, one instant
  xid      bigint      not null default txid_current(),
  tbl      text        not null,
  op       text        not null,                 -- INSERT | UPDATE | DELETE | TRUNCATE
  row_key  jsonb       not null,                 -- primary key, e.g. {"id": "1101"}
  old_row  jsonb,                                -- null: the row did not exist before
  db_user  text        not null default session_user,
  app      text        default current_setting('application_name', true)
);
create index if not exists row_history_key_idx on row_history (tbl, row_key, id);
create index if not exists row_history_at_idx  on row_history (tbl, at);
alter table row_history enable row level security;

comment on table row_history is
  'The row as it stood before every insert, update, delete and truncate on a '
  'data table. Encrypted roster columns are kept as ciphertext. Restore with '
  'restore_as_of / restore_all_as_of.';

-- Which tables are covered, keyed how, and in what order a restore writes them.
create table if not exists row_history_tables (
  tbl           text primary key,
  key_cols      text[] not null,
  restore_order integer not null
);
alter table row_history_tables enable row level security;

create or replace function row_history_key(p_row jsonb, p_cols text[])
  returns jsonb language sql immutable
as $$ select jsonb_object_agg(c, p_row -> c) from unnest(p_cols) c $$;

-- SECURITY DEFINER so the copy is written whoever makes the change; RLS keeps
-- every other role out of row_history itself.
create or replace function record_row_history() returns trigger
  language plpgsql security definer
  set search_path = public
as $$
declare
  o jsonb;
  n jsonb;
  ok jsonb;
  nk jsonb;
begin
  if tg_op = 'TRUNCATE' then
    execute format(
      'insert into row_history (tbl, op, row_key, old_row)
       select %L, ''TRUNCATE'', row_history_key(to_jsonb(t), $1), to_jsonb(t) from %I t',
      tg_table_name, tg_table_name) using tg_argv;
    return null;
  end if;

  if tg_op <> 'INSERT' then o := to_jsonb(old); ok := row_history_key(o, tg_argv); end if;
  if tg_op <> 'DELETE' then n := to_jsonb(new); nk := row_history_key(n, tg_argv); end if;

  -- An upsert that rewrites a row with what it already held only moves
  -- updated_at. Recording it would bury real changes under every sync.
  if tg_op = 'UPDATE' and (o - 'updated_at') = (n - 'updated_at') then return null; end if;

  insert into row_history (tbl, op, row_key, old_row)
  values (tg_table_name, tg_op, coalesce(ok, nk), o);

  -- A renamed key (reseat.mjs moves 4Ds) also marks the new key as empty
  -- before this change, or a restore would leave the moved row in both places.
  if ok is distinct from nk and ok is not null and nk is not null then
    insert into row_history (tbl, op, row_key, old_row)
    values (tg_table_name, tg_op, nk, null);
  end if;
  return null;
end $$;

create or replace function enable_row_history(p_table text, p_order integer)
  returns void language plpgsql
  set search_path = public
as $$
declare
  cols text[];
  args text;
begin
  select array_agg(a.attname::text order by array_position(i.indkey::int2[], a.attnum))
    into cols
    from pg_index i
    join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey::int2[])
   where i.indrelid = p_table::regclass and i.indisprimary;
  if cols is null then
    raise exception '% has no primary key, so its rows cannot be told apart', p_table;
  end if;
  args := (select string_agg(quote_literal(c), ', ') from unnest(cols) c);

  insert into row_history_tables (tbl, key_cols, restore_order)
  values (p_table, cols, p_order)
  on conflict (tbl) do update set key_cols = excluded.key_cols,
                                  restore_order = excluded.restore_order;

  execute format('drop trigger if exists %I on %I', p_table || '_history', p_table);
  execute format(
    'create trigger %I after insert or update or delete on %I
       for each row execute function record_row_history(%s)',
    p_table || '_history', p_table, args);
  execute format('drop trigger if exists %I on %I', p_table || '_history_truncate', p_table);
  execute format(
    'create trigger %I before truncate on %I
       for each statement execute function record_row_history(%s)',
    p_table || '_history_truncate', p_table, args);
end $$;

-- Parents before children: roster.pid, intake_log and roster_name_guards all
-- reference people, and intake_log references intakes.
--
-- Left out on purpose: auth_tokens and invites (credentials; a copy is another
-- place to steal them from), revs and seating_state (counters - winding one
-- back strands every phone), audit, usage_* and dropped_fields.
set client_min_messages = warning;   -- `drop trigger if exists` NOTICE noise

do $$
declare
  t text;
  i integer := 0;
begin
  foreach t in array array[
    'intakes','people',
    'roster','medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk','conducts','paradestates',
    'tgusers','reportsick','config',
    'duty','calendar','oil_rule',
    'intake_log','roster_name_guards','roster_repairs'
  ] loop
    i := i + 1;
    perform enable_row_history(t, i);
  end loop;
end $$;

reset client_min_messages;

-- ── Restoring ───────────────────────────────────────────────────────────────
--
-- One phase of one table. 'put' writes back every row that existed at p_at
-- and has changed since; 'remove' deletes every row that did not exist at p_at.
-- They are separate so restore_all_as_of can put parents first and remove
-- children first, and never trip a foreign key halfway through.
--
-- The guards from 0004/0010/0013 still apply, and some of them decline a write
-- silently (block_archived_delete, keep_archived_archived). So every row is
-- read back after it is written, and one that did not take is reported under
-- `not_restored` rather than counted as done.
create or replace function restore_table_phase(
  p_table  text,
  p_at     timestamptz,
  p_phase  text,
  p_commit boolean,
  p_keys   jsonb[]
) returns jsonb language plpgsql
  set search_path = public
as $$
declare
  cfg      row_history_tables;
  key_where text;
  cols     text;
  r        record;
  cur      jsonb;
  done     jsonb[] := '{}';
  refused  jsonb[] := '{}';
begin
  select * into cfg from row_history_tables where tbl = p_table;
  if not found then raise exception '% has no row history', p_table; end if;

  -- Each key column compared at its own type, so the primary key index serves
  -- the lookup. Comparing to_jsonb(t) would scan the table once per row.
  select string_agg(format('t.%I = ($1 ->> %L)::%s', a.attname, a.attname,
                           format_type(a.atttypid, a.atttypmod)), ' and ')
    into key_where
    from unnest(cfg.key_cols) c
    join pg_attribute a on a.attrelid = p_table::regclass and a.attname = c;
  select string_agg(quote_ident(attname), ', ' order by attnum) into cols
    from pg_attribute
   where attrelid = p_table::regclass and attnum > 0
     and not attisdropped and attgenerated = '';

  for r in
    select distinct on (h.row_key) h.row_key, h.old_row
      from row_history h
     where h.tbl = p_table and h.at > p_at
       and (p_keys is null or h.row_key = any (p_keys))
     order by h.row_key, h.id
  loop
    continue when (p_phase = 'put') = (r.old_row is null);

    execute format('select to_jsonb(t) from %I t where %s', p_table, key_where)
      into cur using r.row_key;
    continue when (cur - 'updated_at') is not distinct from (r.old_row - 'updated_at');

    if p_commit then
      if r.old_row is null then
        execute format('delete from %I t where %s', p_table, key_where) using r.row_key;
      elsif cur is null then
        execute format('insert into %I (%s) select %s from jsonb_populate_record(null::%I, $1)',
                       p_table, cols, cols, p_table) using r.old_row;
      else
        execute format('update %I t set (%s) = (select %s from jsonb_populate_record(null::%I, $2))
                         where %s', p_table, cols, cols, p_table, key_where)
          using r.row_key, r.old_row;
      end if;

      execute format('select to_jsonb(t) from %I t where %s', p_table, key_where)
        into cur using r.row_key;
      if (cur - 'updated_at') is distinct from (r.old_row - 'updated_at') then
        refused := array_append(refused, r.row_key);
        continue;
      end if;
    end if;
    done := array_append(done, r.row_key);
  end loop;

  return jsonb_build_object(
    case when p_phase = 'put' then 'restored' else 'removed' end, to_jsonb(done),
    'not_restored', to_jsonb(refused));
end $$;

-- Both entry points. Dry run unless p_commit; the report lists, per table, the
-- keys it would restore or remove (or did), so a dry run previews exactly what
-- will move. Atomic: any error rolls the whole restore back.
--
-- A committed restore takes the lock a reseat takes, so no phone writes
-- mid-restore, and bumps each tab's rev so every phone pulls the result. If
-- roster rows move the seating epoch moves too: what a 4D means may have
-- changed, and a phone saving against the old meaning must reload first.
create or replace function restore_tables(
  p_tables text[],
  p_at     timestamptz,
  p_commit boolean,
  p_keys   jsonb[]
) returns jsonb language plpgsql
  set search_path = public
as $$
declare
  report jsonb := '{}'::jsonb;
  t      text;
  part   jsonb;
begin
  if p_commit then
    perform pg_advisory_xact_lock(6413161608::bigint);
    perform bump_rev(r.tab) from revs r where lower(r.tab) = any (p_tables);
  end if;

  for t in select tbl from row_history_tables where tbl = any (p_tables)
            order by restore_order loop
    report := report || jsonb_build_object(t,
      restore_table_phase(t, p_at, 'put', p_commit, p_keys));
  end loop;
  for t in select tbl from row_history_tables where tbl = any (p_tables)
            order by restore_order desc loop
    part := restore_table_phase(t, p_at, 'remove', p_commit, p_keys);
    report := jsonb_set(report, array[t], (report -> t) || jsonb_build_object(
      'removed', part -> 'removed',
      'not_restored', (report #> array[t, 'not_restored']) || (part -> 'not_restored')));
  end loop;

  -- Only the tables something happens to.
  report := coalesce((select jsonb_object_agg(key, value) from jsonb_each(report)
                       where value <> '{"restored": [], "removed": [], "not_restored": []}'),
                     '{}'::jsonb);

  if p_commit and (report -> 'roster') is not null then
    update seating_state set epoch = epoch + 1 where singleton;
  end if;
  return report || jsonb_build_object('as_of', p_at, 'committed', p_commit);
end $$;

create or replace function restore_as_of(
  p_table  text,
  p_at     timestamptz,
  p_commit boolean default false,
  p_keys   jsonb[] default null
) returns jsonb language sql
  set search_path = public
as $$
  select case when exists (select 1 from row_history_tables where tbl = p_table)
              then restore_tables(array[p_table], p_at, p_commit, p_keys)
              else restore_table_phase(p_table, p_at, 'put', false, null) end  -- raises
$$;

-- Every covered table at once, for corruption that spans tabs: a bad reseat,
-- or a stale phone pushing its whole cache.
create or replace function restore_all_as_of(
  p_at     timestamptz,
  p_commit boolean default false
) returns jsonb language sql
  set search_path = public
as $$
  select restore_tables(array(select tbl from row_history_tables), p_at, p_commit, null)
$$;

-- ── Retention ───────────────────────────────────────────────────────────────
-- Same window as the audit trim in purge_retention, and dry run by default
-- like it. Kept out of purge_retention so this migration does not have to
-- redefine that function yet again.
create or replace function purge_row_history(
  p_commit boolean default false,
  p_days   integer default 730
) returns jsonb language plpgsql
  set search_path = public
as $$
declare n bigint;
begin
  select count(*) into n from row_history where at < now() - make_interval(days => p_days);
  if p_commit then
    delete from row_history where at < now() - make_interval(days => p_days);
  end if;
  return jsonb_build_object('row_history', n, 'committed', p_commit);
end $$;
