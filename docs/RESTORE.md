# Restoring data from row history

Every insert, update, delete and truncate on a data table keeps a copy of the row as it stood before the change, in `row_history` (`supabase/migrations/0014_row_history.sql`).
It is a trigger, so it covers every write path: the app, scripts, the SQL editor, `purge_retention`, migrations.
Encrypted roster columns are kept as ciphertext, so a corrupted date of birth or next-of-kin record can be put back, which the audit trail cannot do.

## Find the moment it went wrong

```sql
-- Everything that happened to one row, newest first.
select id, at, op, db_user, old_row
  from row_history
 where tbl = 'medical' and row_key = '{"id": "mdq1-ab12-3"}'
 order by id desc;

-- Every change to a table in a window, to spot a bad bulk write.
select at, op, count(*)
  from row_history
 where tbl = 'medical' and at > now() - interval '1 day'
 group by at, op order by at desc;
```

`at` is the start of the transaction that made the change, so one bad write shows up as one instant with many rows.
The Edge Function logs the audit row for an app write just after it commits, so the audit row a moment later says who made it:

```sql
select at, person, action, tab from audit
 where tab = 'Medical' and at between '2026-10-19 22:39+08' and '2026-10-19 22:40+08';
```

Pick a restore point just before the bad write.

## Preview, then restore

Every restore is a dry run unless the third argument is `true`.
The dry run lists exactly the keys it would restore and remove, so read it before committing.

```sql
-- One table.
select restore_as_of('medical', '2026-10-19 22:39+08');
select restore_as_of('medical', '2026-10-19 22:39+08', true);

-- Only some rows of it.
select restore_as_of('roster', '2026-10-11 13:12+08', true,
                     array['{"id": "9302"}'::jsonb]);

-- Every covered table, for damage that spans tabs (a bad reseat, a stale phone pushing its cache).
select restore_all_as_of('2026-10-07 06:59+08');
select restore_all_as_of('2026-10-07 06:59+08', true);
```

A restore of a whole table also undoes the good edits made after the restore point.
When the damage is a few rows, pass their keys.

## What a committed restore does

- Holds the lock a reseat takes, so no phone writes until it finishes.
- Bumps each restored tab's rev, so every phone pulls the restored rows.
- Moves the seating epoch if it touched `roster`, so a phone still holding the old roster must reload before it can save.
- Is atomic: if any row fails (a foreign key, a unique index), nothing is restored.
- Is itself recorded in `row_history`, so a wrong restore is undone by restoring to just before it.

## `not_restored`

The archive guards from `0004`, `0010` and `0013` still apply to a restore.
`keep_archived_archived` and `block_archived_delete` decline some writes silently, so every row is read back after it is written, and one that did not take is listed under `not_restored` instead of `restored`.
That is usually right (an archived man stays archived).
If it is not, make the change by hand in psql.

## Not covered

`auth_tokens` and `invites` (credentials), `revs` and `seating_state` (counters), `audit`, `usage_*` and `dropped_fields`.

## Retention

`purge_row_history()` trims entries older than 730 days, the same window as the audit trim.
It is a dry run by default, like `purge_retention`, and is not scheduled.
History keeps rows that `purge_retention` hard-deletes, for that window.
