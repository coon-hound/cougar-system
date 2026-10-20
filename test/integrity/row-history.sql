-- Row history (0014) against a real Postgres. Synthetic rows only, every one
-- keyed rh-*. Each statement is its own transaction, because a restore point
-- sits BETWEEN transactions: row_history.at is the transaction's start time.
--
--   psql "$DB" -v ON_ERROR_STOP=1 -f test/integrity/row-history.sql
\set ON_ERROR_STOP 1
\set QUIET 1
\o /dev/null
create function pg_temp.check(ok boolean, what text) returns void language plpgsql as $$
begin
  if ok is not true then raise exception 'FAIL: %', what; end if;
  raise notice 'ok - %', what;
end $$;

-- ── An edited and a newly added row both go back ───────────────────────────
insert into medical ("id", "d4", "status", "reason") values ('rh-m1', '1101', 'MC', 'Fever');
select pg_sleep(0.01);
select now() as t1 \gset
select pg_sleep(0.01);
update medical set "reason" = 'WRONG', "d4" = '9999' where "id" = 'rh-m1';
insert into medical ("id", "d4", "status") values ('rh-m2', '1102', 'LD');
update medical set "status" = "status" where "id" = 'rh-m1';   -- a no-op upsert

select pg_temp.check(
  (select count(*) from row_history where tbl = 'medical' and row_key = '{"id":"rh-m1"}') = 2,
  'insert and real update are recorded; a no-op update is not');

select restore_as_of('medical', :'t1') as dry \gset
select pg_temp.check(
  (select "reason" from medical where "id" = 'rh-m1') = 'WRONG',
  'a dry run changes nothing');
select pg_temp.check(
  :'dry'::jsonb #> '{medical,restored}' = '[{"id":"rh-m1"}]'
  and :'dry'::jsonb #> '{medical,removed}' = '[{"id":"rh-m2"}]',
  'a dry run names exactly the rows it would move');

select (select rev from revs where tab = 'Medical') as rev0 \gset
select restore_as_of('medical', :'t1', true);
select pg_temp.check(
  (select ("reason", "d4") = ('Fever', '1101') from medical where "id" = 'rh-m1'),
  'the edited row is back as it was');
select pg_temp.check(
  not exists (select 1 from medical where "id" = 'rh-m2'),
  'the row added since is gone');
select pg_temp.check(
  (select rev from revs where tab = 'Medical') > :rev0,
  'the restore bumps the rev so phones pull it');

-- A restore is itself a change, so it can be undone the same way.
select now() as t2 \gset
select pg_sleep(0.01);
select restore_as_of('medical', :'t1', true);   -- nothing left to do
select pg_temp.check(
  (select restore_as_of('medical', :'t1') -> 'medical') is null,
  'restoring twice is a no-op');

-- ── Encrypted columns come back, still encrypted ───────────────────────────
insert into roster ("id", "name", "dob") values ('rh-r1', 'SYNTHETIC ONE', enc_col('01 Jan 2005', 'k'));
select pg_sleep(0.01);
select now() as t3 \gset
select pg_sleep(0.01);
update roster set "dob" = enc_col('31 Dec 1999', 'k') where "id" = 'rh-r1';
select pg_temp.check(
  (select old_row ->> 'dob' from row_history where row_key = '{"id":"rh-r1"}' and op = 'UPDATE')
    not like '%2005%',
  'history holds the ciphertext, not the date of birth');
select (select epoch from seating_state) as epoch0 \gset
select restore_as_of('roster', :'t3', true);
select pg_temp.check(
  (select dec_col("dob", 'k') from roster where "id" = 'rh-r1') = '01 Jan 2005',
  'an overwritten encrypted field is recovered');
select pg_temp.check(
  (select epoch from seating_state) > :epoch0,
  'a roster restore moves the seating epoch');

-- ── A renamed key (reseat) does not leave the row in both places ───────────
select now() as t4 \gset
select pg_sleep(0.01);
update roster set "id" = 'rh-r2' where "id" = 'rh-r1';
select restore_as_of('roster', :'t4', true);
select pg_temp.check(
  exists (select 1 from roster where "id" = 'rh-r1')
  and not exists (select 1 from roster where "id" = 'rh-r2'),
  'a renamed key is put back under its old key only');

-- ── MSK full-tab write: hard delete then reinsert ──────────────────────────
insert into msk ("d4", "description") values ('rh-k1', 'knee'), ('rh-k2', 'ankle');
select pg_sleep(0.01);
select now() as t5 \gset
select pg_sleep(0.01);
delete from msk where "d4" like 'rh-%';
insert into msk ("d4", "description") values ('rh-k3', 'stale phone');
select restore_as_of('msk', :'t5', true);
select pg_temp.check(
  (select string_agg("description", ',' order by "description") from msk where "d4" like 'rh-%') = 'ankle,knee',
  'hard-deleted MSK rows come back and the stray one goes');

-- ── TRUNCATE ────────────────────────────────────────────────────────────────
select now() as t6 \gset
select pg_sleep(0.01);
truncate msk;
select restore_all_as_of(:'t6', true);
select pg_temp.check(
  (select count(*) from msk where "d4" like 'rh-%') = 2,
  'a truncated table is recoverable');

-- ── A guard that declines the write is reported, not counted as done ───────
-- Archived after t7. keep_archived_archived will not un-archive it, so the
-- restore must say the row did not come back.
insert into medical ("id", "d4", "status", "intake") values ('rh-m3', '1103', 'MC', 'some-old-intake');
select pg_sleep(0.01);
select now() as t7 \gset
select pg_sleep(0.01);
update medical set "deleted_at" = now() where "id" = 'rh-m3';
select restore_as_of('medical', :'t7', true) as declined \gset
select pg_temp.check(
  :'declined'::jsonb #> '{medical,not_restored}' = '[{"id":"rh-m3"}]'
  and :'declined'::jsonb #> '{medical,restored}' = '[]',
  'a write a guard declines is reported as not restored');

-- ── Retention ───────────────────────────────────────────────────────────────
select pg_temp.check(
  (purge_row_history() ->> 'committed')::boolean = false,
  'purge_row_history is a dry run by default');

-- Leave the synthetic rows out of whatever runs next.
delete from medical where "id" like 'rh-%';
delete from roster where "id" like 'rh-%';
delete from msk where "d4" like 'rh-%';
\echo row-history: all checks passed
