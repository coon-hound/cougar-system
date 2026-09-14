# Changing over to a new intake

The runbook for the day the company empties out and refills.

For the file you need from HQ, see [NOMINAL-ROLL.md](NOMINAL-ROLL.md).
That page is safe to forward; this one is for whoever runs the changeover.

## What a changeover has to get right

Three things, in order of how badly they hurt when they go wrong.

**A returning enlistee must keep his medical history.**
Someone recoursed or back-squadded comes back under a *different* 4D, because a 4D is a seat, not a person.
Digit 1 is the platoon and digit 2 the section, so the whole range is reissued every intake.
His injury history sits under the old number and has to be moved to the new one, or it is lost at exactly the moment it matters most.

**Two people must never be merged.**
The opposite error is worse and quieter.
If the matcher guesses wrong, a recruit silently inherits a stranger's medical record and nothing downstream will ever flag it.
So anything short of an exact match stops the run and asks.

**The previous cohort must not vanish, and must not pollute.**
Their records stay in the database, queryable forever, but out of the app's sight so the new cohort's strength and attendance numbers are their own.

## How it works, in one paragraph

Every row gets stamped with an intake label and soft-deleted.
Nothing is exported and nothing is deleted, because every read the backend does is already `where deleted_at is null`.
So archiving is a stamp, the archive is a `WHERE` clause, and undoing it is an `UPDATE`.
The outgoing roster's ids are re-keyed from `1101` to `1101@25-08` first, because `roster.id` **is** the 4D and **is** the primary key, so the incoming cohort needs those seats back.
A permanent `people` registry gives every human a `pid` that never changes, so this is the last changeover that has to match anybody on a name.

## Before the day

1. Apply `supabase/migrations/0004_intake.sql` if it is not applied yet.
   It is additive and safe over populated tables.
   Everything already in the database gets stamped `bootstrap`, which the first real changeover renames.

2. Redeploy the Edge Function.
   It caches the `dropped_fields` deny-list for the life of a warm instance, and 0004 adds two rows to it.
   Until it restarts, a client could still write `pid` and `intake`.

3. Get the nominal roll as a CSV. See [NOMINAL-ROLL.md](NOMINAL-ROLL.md).

4. Decide two things and write them down:
   - the **label** for the incoming intake, e.g. `26/02`
   - the **label for the outgoing one**, e.g. `25/08` — this is what you will type into a query in a year's time, so pick something you will recognise
   - the **cutoff**, the incoming cohort's first day in camp, as `YYYY-MM-DD`

## The run

Preview first. It reads and writes nothing, and you can run it as many times as you like.

```bash
export DATABASE_URL=...        # the Supabase connection string
export COUGAR_ENC_KEY=...      # the same key the Edge Function uses

node scripts/intake-migrate.mjs roll.csv \
  --label 26/02 --prev 25/08 --cutoff 2026-02-16
```

Read the report.
It names every returnee it found, says what moved, and lists anything it refuses to decide on its own.

Work the blocking list until it is empty.
Almost all of them are resolved by pinning a row:

```bash
  --override 1101=P4F2A9C1B0     # yes, this is that person
  --override 1102=NEW            # no, different person who shares a surname
```

The report prints the exact line to add for each one.
`--accept-fuzzy` takes every near-miss at once, and is only for when you have read them all.

When the report ends in `READY`, run it again with `--apply`.

```bash
node scripts/intake-migrate.mjs roll.csv \
  --label 26/02 --prev 25/08 --cutoff 2026-02-16 --apply
```

It is one transaction.
If anything fails, nothing is committed and the previous cohort is untouched.

## Immediately after

The script prints this list too. It matters.

1. **Bump `STORAGE_KEY` in `js/state.js`** (`cougar-data-v2` to `-v3`) and the `?v=` in `index.html`.
   Every phone in the field still holds the previous cohort in localStorage.
   The revision bumps stop those phones overwriting anything, but until the cache is dropped they still *show* the old company, and a commander acting on a recruit who is no longer here can create rows for a 4D nobody holds.
   Bumping the key is what forces every device to throw its cache away and pull fresh.

2. **Redeploy the Edge Function** if you did not already.

3. **Re-check the platoon to program map** in the Conducts tab.
   The new intake may split PTP and BMT across different platoons than the last one did.

4. **Re-issue invites**, and reset the Telegram registrations so recruits re-register against the new 4Ds.

## What carries, and what does not

| | |
|---|---|
| **Follows the person** | Medical, MSK, IPPT, Route March, SOC |
| **Follows the person, future only** | Appointments |
| **Stays put** | Commanders and everything of theirs, including leave and off-in-lieu balances |
| **Archived in full** | Attendance, ConductDetail, PolarFlow |
| **Untouched** | Conducts |

The line is whether a record describes the **human** or the **cohort**.

Medical and MSK are clinical and belong to the person.
IPPT, route march and SOC are a fitness baseline, so a returnee's next attempt is compared against his own last one instead of appearing from nowhere.

Attendance, ConductDetail and PolarFlow are records of specific conducts on specific dates that the incoming cohort did not attend.
Carrying those would corrupt exactly the numbers the dashboard exists to report.

To change any of this, edit `CARRY_RULES` in `scripts/intake-plan.mjs`.
It is one table and it is the only place the policy lives.

### One deliberate edit to the data

A medical status still open on changeover day is closed the day before the cutoff, and every one of them is listed in the report under `OPEN MEDICAL STATUSES CLOSED AT CHANGEOVER`.

Without that, a returnee turns up on his first parade state on an MC issued months ago.
The archived original keeps the real end date, so nothing is lost, but **the people on that list need their status re-verified** rather than assumed.

## Reading the archive

```sql
-- everything the previous cohort did
select * from medical where intake = '25/08';
select * from roster  where intake = '25/08';

-- who has been here more than once
select * from person_history where seats_held > 1;

-- what moved, when, and on what evidence
select * from intake_log order by at desc;
```

`person_history` is the one worth remembering.
It answers "what has this person done across every intake they have been in", which is otherwise a join through `d4_history` that nobody writes correctly at two in the morning.

## If it goes wrong

Nothing is deleted, so nothing is unrecoverable.

A run that failed committed nothing at all.
A run that succeeded but matched somebody wrongly is corrected by fixing the `pid` on the affected `people` row and moving the records back with an `UPDATE`; `intake_log` records exactly what moved where.

The blunt instrument, if the whole run was wrong:

```sql
-- put the previous cohort back, then re-run the changeover properly
update intakes set is_current = true  where label = '25/08';
update intakes set is_current = false where label = '26/02';
update roster set deleted_at = null, "id" = split_part("id", '@', 1)
 where intake = '25/08';
-- and the same for each child table, with "d4" in place of "id"
```

Do this with the app offline, and pull fresh on every device afterwards.

## Two things that are protected, and one that is not

`0004_intake.sql` closes the two ways a stale phone could damage the archive, in SQL rather than in the Edge Function, so the guarantee does not depend on a deployment being current.

- A full-tab push would otherwise **revive** the whole previous cohort, because every upsert clears `deleted_at`. The revival is silently declined.
- A full-tab MSK write **hard-deletes** the table before reinserting, because MSK has no `id` to diff on. Archived rows are skipped.

What is **not** fully closed: a stale device can still create a *new* row for an old 4D, because from the backend's point of view that is indistinguishable from adding a person.
Full-tab writes are rejected on a stale revision, so this is limited to single-row edits in the window between the changeover and that device's next pull.
Bumping `STORAGE_KEY` closes the window, which is why it is step 1 above and not an afterthought.
