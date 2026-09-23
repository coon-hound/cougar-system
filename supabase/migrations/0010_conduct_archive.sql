-- ============================================================================
-- 0010_conduct_archive.sql - conducts joins the intake archive
--
-- Written 16 Sep 2026 as 0007; renumbered and re-derived against production
-- on 23 Sep 2026 (0007 went to departures, 0008 is claimed by an open branch,
-- 0009 is duty). The rule the user set: archive every conduct logged before
-- the intake 16 cutoff (14 Sep 2026) that intake 16 has not logged since.
--
-- THE PROBLEM
-- -----------
-- `conducts` is the registry behind every conduct picker in the app - one flat
-- `<select>` (js/forms.js conductPicker) that a commander scrolls one-handed on
-- a phone. It holds 112 entries. Five of them are this intake's. The other 107
-- are the previous cohort's training calendar, carried across the Sheets ->
-- Postgres import, and they are full of near-duplicates ("BCCT 7" twice,
-- "Endurance Run 1/7" beside "Endurance Run 2"). Picking the right one off that
-- list is a guess, and a wrong guess files attendance against last cohort's
-- conduct with nothing downstream to flag it.
--
-- WHY IT WAS LEFT OUT OF 0004
-- ---------------------------
-- 0004_intake.sql excluded conducts from the archive on an explicit premise
-- (see its section 4): conducts is "a vocabulary of conduct NAMES, which recur
-- every intake". That premise did not survive contact. Two days into intake 16
-- the company created a NEW "ENDURANCE RUN 1" (cmu3bdoe7-re7lub-1) rather than
-- reuse c4136 "Endurance Run 1/7". Names are retyped, not reused, so the
-- registry only ever grows.
--
-- The exclusion had a second cost that is worse than the clutter: with no
-- `intake` column, conducts is the one tracked table with NO defence at all
-- against a stale phone. `upsertOne` ends every write `deleted_at = null`
-- (supabase/functions/api/index.ts), so a soft delete on conducts is undone by
-- the next rename or full-tab push from any device still holding the row. This
-- migration is therefore not only "hide the clutter" - it is what makes hiding
-- it stick.
--
-- WHAT THIS DOES
-- --------------
-- Folds conducts into the machinery 0004 already built, inventing nothing:
-- the same `intake` stamp, the same partial index, the same two trigger
-- functions verbatim, the same dropped_fields lock. Then it stamps the 107 old
-- conducts with the outgoing intake and soft-deletes them. Every read in the
-- Edge Function is `where deleted_at is null`, so the picker drops from 112 to
-- 5 and the registry tab shows 5, with ZERO frontend changes.
--
-- WHY IT IS SAFE
-- --------------
-- Nothing live points at the 107. Verified against production on 23 Sep 2026:
--
--   live attendance rows    : 4   (one per logged keeper below)
--   live conductdetail rows : all -> the same four keepers
--   live polarflow rows     : 0
--   live rows -> any of the 107 : 0
--
-- So no record renders as a `[c001?]` placeholder. There are no foreign keys
-- from attendance / conductdetail / polarflow to conducts - `conductId` is a
-- soft reference - so archiving cannot fail a constraint, and it also cannot be
-- caught by one. The DO block below therefore RE-CHECKS that count at apply
-- time and aborts if the database has moved on since. That check, not this
-- comment, is the actual guarantee.
--
-- Fully reversible:  update conducts set deleted_at = null where intake = 'bmt';
-- (from psql - deliberately NOT from the app; see the trigger note below.)
--
-- THE KEEPER LIST IS EXPLICIT, AND HAS TO BE
-- ------------------------------------------
-- There is no created_at on conducts, only updated_at, and `conducts_touch`
-- (0001) rewrites it on every UPDATE. Worse, the Sheets import stamped all 109
-- imported rows with a single updated_at of 2026-09-14 00:35:44+00 - which is
-- AFTER the intake 16 cutoff of 2026-09-14. Any "keep what looks recent" rule
-- keeps all of them or none. So the rows to archive are named, one by one.
--
-- The five keepers, and why each is a keeper:
--
--   cmu3bdoe7-re7lub-1  "ENDURANCE RUN 1"       logged by intake 16, 16 Sep
--   c6117               "Metabolic Circuit 1"   logged by intake 16, 17 Sep
--   c016                "Sports and Games"      logged by intake 16, 17 Sep
--   cmuaff9rl-0dowj3-1  "Strength & Power 2"    logged by intake 16, 21 Sep
--       Archiving any of these turns intake 16's live records into [id?]
--       placeholders. c6117 and c016 are imported old-cohort entries that
--       intake 16 reused, so they are restamped to the current intake below.
--
--   c9020               "12km RM"
--       ZERO usage, so it is indistinguishable by reference count from the six
--       dead unreferenced entries among the 107. It is a keeper because it was
--       written on 2026-09-15 13:48, i.e. it is an intake-16 conduct that
--       nobody has logged against yet. This is the one that a usage-based rule
--       silently gets wrong.
--
-- Additive and safe over populated tables, like 0003 and 0004. Rerunnable.
-- ============================================================================

-- ── 1. The stamp ────────────────────────────────────────────────────────────
--
-- Identical to what 0004 did to the other eleven cohort-scoped tables. The
-- column DEFAULT means every conduct created from here on stamps itself, with
-- no Edge Function change and no client change. `current_intake()` is `stable`,
-- which is why the index predicate is on deleted_at and not on it.

alter table conducts add column if not exists intake text default current_intake();
update conducts set intake = current_intake() where intake is null;
create index if not exists conducts_intake_idx on conducts (intake) where deleted_at is null;

comment on column conducts.intake is
  'Cohort that owns this conduct. Server-owned: see dropped_fields. Conduct '
  'names are retyped rather than reused each intake (0004 assumed otherwise), '
  'so the registry is cohort-scoped like everything else.';

-- ── 2. The two guards, reused verbatim ──────────────────────────────────────
--
-- No new trigger logic. `keep_archived_archived` and `block_archived_delete`
-- are the functions 0004 defined and that have been in production on eleven
-- tables since 14 Sep 2026; this only widens the table list they are installed
-- on. Read 0004 section 6 for why the first one fails SILENTLY rather than
-- raising (an exception aborts the transaction, js/sync.js retries forever, and
-- one stale phone locks every device out of writing).
--
-- keep_archived_archived closes the upsertOne `deleted_at = null` path, which
-- is what a rename (js/forms.js renameConduct -> autoSync upsert) and a
-- full-tab Conducts write both travel down.
--
-- block_archived_delete matters less here than on MSK - conducts has an `id`,
-- so writeWholeTab soft-deletes rather than hard-deletes it - but purge_retention
-- (0002) hard-deletes soft-deleted conducts once past its window, and archived
-- history must outlive that. Installing it is what stops the archive being
-- quietly reaped in 90 days.
--
-- CONSEQUENCE, stated plainly because it is easy to be surprised by: once a
-- conduct is stamped with a non-current intake AND soft-deleted, the app can
-- never revive it. Un-archiving is a psql UPDATE, not a click. That is why the
-- keepers below must be stamped with the CURRENT intake in the same run.

set client_min_messages = warning;   -- `drop trigger if exists` NOTICE noise

drop trigger if exists conducts_keep_archived on conducts;
create trigger conducts_keep_archived before update on conducts
  for each row execute function keep_archived_archived();

drop trigger if exists conducts_block_arch_del on conducts;
create trigger conducts_block_arch_del before delete on conducts
  for each row execute function block_archived_delete();

reset client_min_messages;

-- ── 3. Server-owned, so no phone can restamp it ─────────────────────────────
--
-- api_row returns every real column, so `intake` now rides along in every
-- readAll Conducts row and in anything that copies one. js/forms.js
-- renameConduct upserts the whole STATE row back, which would otherwise let a
-- client write its own cohort stamp. shapeRow drops deny-listed fields on the
-- way in, exactly as it does for roster.pid and roster.intake.
--
-- NOTE the Edge Function caches dropped_fields in a module-level `DENIED` for
-- the life of a warm instance. THIS ROW DOES NOTHING UNTIL THE FUNCTION IS
-- REDEPLOYED. Redeploy after applying; do not wait for a cold start.

insert into dropped_fields (tab, field, reason) values
  ('Conducts', 'intake', 'server-owned cohort stamp; assigned by 0010 and intake-migrate.mjs')
on conflict (tab, field) do nothing;

-- ── 4. The backfill ─────────────────────────────────────────────────────────
--
-- Explicit ids, not a predicate. A conduct created between the writing of this
-- migration and its application is untouched by construction, because it is not
-- on the list.

do $$
declare
  -- The 107 conducts belonging to the cohort that left on 14 Sep 2026.
  -- Enumerated from production; every one of them has zero live references.
  archive_ids text[] := array[
    'c001','c002','c003','c004','c005','c006','c007','c008','c009','c010',
    'c011','c012','c013','c014','c018','c019','c020','c021','c022',
    'c023','c024','c025','c026','c028','c029','c030','c031','c032','c033',
    'c034','c035','c036','c037','c038','c039','c040','c041','c042','c043',
    'c044','c045','c046','c047','c048','c050','c1474','c1551','c1726','c1760',
    'c1897','c2137','c2593','c3190','c3191','c3192','c3491','c3755','c3873',
    'c4136','c4396','c4409','c4449','c4547','c4593','c4745','c4746','c4922',
    'c4976','c5068','c5207','c5262','c5417','c5440','c5598','c6101','c6102',
    'c6103','c6104','c6105','c6106','c6107','c6108','c6109','c6110','c6111',
    'c6112','c6113','c6114','c6115','c6116','c6285','c6322','c6750',
    'c6815','c6837','c6859','c6973','c7152','c7213','c7974','c8205','c8341',
    'c8543','c8599','c8809','c9060','c9930'
  ];
  -- Stated separately and asserted against the list above, so that a future
  -- edit cannot quietly move one of them into the archive set.
  keeper_ids text[] := array[
    'cmu3bdoe7-re7lub-1', 'cmuaff9rl-0dowj3-1', 'c6117', 'c016', 'c9020'
  ];

  archive_label text;
  overlap       text[];
  still_used    bigint;
  n_present     int;
  n_archived    int;
  n_kept        int;
begin
  -- A keeper must never appear in the archive list.
  select array_agg(k) into overlap
    from unnest(keeper_ids) k where k = any (archive_ids);
  if overlap is not null then
    raise exception '0010: keeper(s) % are also in the archive list', overlap;
  end if;

  -- Which cohort do the old conducts belong to? The outgoing one - on
  -- production, 'bmt'. Derived rather than hard-coded so this migration also
  -- applies cleanly to a local or rehearsal database whose labels differ.
  select label into archive_label
    from intakes where not is_current
   order by cutoff_date, applied_at
   limit 1;

  if archive_label is null then
    raise warning '0010: no non-current intake is registered, so there is no '
                  'cohort to archive these conducts under. Schema changes above '
                  'are applied; the backfill is skipped.';
    return;
  end if;

  select count(*) into n_present from conducts where "id" = any (archive_ids);

  -- THE REAL GUARD. conductId is a soft reference with no foreign key, so
  -- nothing in the database would stop this from orphaning live records. Count
  -- them here, at apply time, against whatever the database actually holds -
  -- not against the snapshot this migration was written from. Zero on
  -- production as of 23 Sep 2026; anything else means the situation changed and
  -- a human should look before the picker loses those entries.
  select (select count(*) from attendance    a where a.deleted_at is null and a."conductId" = any (archive_ids))
       + (select count(*) from conductdetail d where d.deleted_at is null and d."conductId" = any (archive_ids))
       + (select count(*) from polarflow     p where p.deleted_at is null and p."conductId" = any (archive_ids))
    into still_used;

  if still_used > 0 then
    raise exception '0010: % live record(s) still point at conducts on the '
                    'archive list. Archiving would render them as [id?] '
                    'placeholders. Re-derive the list before applying.',
                    still_used;
  end if;

  -- The keepers first, so that if anything below fails the current-intake stamp
  -- is not the half that is missing. Deliberately does NOT touch deleted_at:
  -- reviving an already-archived keeper is silently declined by the trigger
  -- installed above, and a statement that looks like it works but does not is
  -- worse than one that is plainly not there.
  update conducts set intake = current_intake()
   where "id" = any (keeper_ids) and intake is distinct from current_intake();
  get diagnostics n_kept = row_count;

  -- Stamp and archive in ONE statement. Two statements would leave a window in
  -- which a row is stamped with a dead cohort but still visible to every phone.
  update conducts
     set intake     = archive_label,
         deleted_at = coalesce(deleted_at, now())
   where "id" = any (archive_ids)
     and (intake is distinct from archive_label or deleted_at is null);
  get diagnostics n_archived = row_count;

  raise notice '0010: archived % of % listed conduct(s) under intake %; % keeper(s) restamped to %.',
               n_archived, n_present, archive_label, n_kept, current_intake();

  if n_present <> cardinality(archive_ids) then
    raise warning '0010: % of the % listed ids are not present in conducts. '
                  'Expected 0 missing on production; a non-zero count means '
                  'this is a different database or the registry was edited.',
                  cardinality(archive_ids) - n_present, cardinality(archive_ids);
  end if;
end $$;

-- ── 5. Tell the devices ─────────────────────────────────────────────────────
--
-- What the Conducts tab returns just changed. Without a rev bump no phone pulls
-- it, every device keeps showing all 112, and the first full-tab Conducts write
-- from one of them arrives holding rows this migration archived. The trigger
-- refuses to revive them, so nothing is undone - but the bump is what makes the
-- change visible rather than merely safe.

select bump_rev('Conducts');
