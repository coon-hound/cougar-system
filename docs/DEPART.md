# Posting a man out

The runbook for one man leaving the company: posted out, downgraded, recoursed, back-squadded, or medically boarded.

This is not a change of intake, and it is not a re-sectioning.
One man goes, his records are archived, and the section he leaves closes up behind him.
For a whole new cohort see [INTAKE-MIGRATION.md](INTAKE-MIGRATION.md); for re-dealing a platoon's seats see [RESEAT.md](RESEAT.md).

## Do not just delete him in the app

Deleting a recruit in the app sets `deleted_at` on his roster row.
That is not an archive.
`purge_retention()` hard-deletes every roster row soft-deleted longer ago than the retention window, together with every child row keyed on his 4D, so an app-level delete is a ninety-day fuse on his medical history.

It also leaves his 4D occupied.
`roster.id` **is** the 4D and **is** the primary key, so a tombstoned row still holds the seat, and the next man to need it collides with a row nobody can see.

An archive is the pattern `0004_intake.sql` established for a change of intake.
His rows are re-keyed out of the live 4D namespace and soft-deleted:

```
roster.id   9404  ->  9404@16-out-20260921
medical.d4  9404  ->  9404@16-out-20260921
```

The rows stay in Postgres, stay indexed, stay queryable, and stay joined to each other.
They simply stop being visible to the app, because every read in the Edge Function is `where deleted_at is null`.
Re-keying him is also what frees the seat.

The key carries the date as well as the intake label, which a cohort archive key does not need to.
A departure can happen twice to the same seat inside one intake: the man who moves up into 9404 today can be posted out himself in November, and a bare `9404@16` would then collide with this one.

## The run

```bash
export DATABASE_URL=...        # the Supabase connection string

node scripts/depart.mjs 9404
node scripts/depart.mjs "ALPHA TAN" --plt 5
```

Preview first.
It reads and writes nothing, and you can run it as often as you like.

Names are **not** printed unless you add `--names`, so the report is safe to paste into a chat.

When it ends in `READY`, run it again with `--apply` and a reason.

```bash
node scripts/depart.mjs 9404 --apply --reason "posted out to 46 SAR"
```

It is one transaction: if anything fails, nothing is committed.
The reason lands in `intake_log.note`, which is the difference between a log entry and an answer.

## Naming him

A 4D, or a name that resolves to exactly one roster row.
Nothing else.

An ambiguous or unrecognised name stops the run and is reported with ranked candidates rather than guessed at.
This is the same matcher a two-man swap uses, and it is strict for the same reason: the cost of resolving the wrong man is that a serving recruit is archived and a departed one keeps a live seat, and the app shows both as perfectly normal.

`--plt` is an optional guard.
Name it and he must be in that platoon, so a name that quietly resolved into a different one stops the run.

**A 4D names whoever holds that seat today.**
The moment a departure renumbers a section, the number you typed last week belongs to a different man.
Read the preview, with `--names` if you are not certain, before adding `--apply`.

## What renumbering does

The section he leaves is re-dealt alphabetically into seats 1..n, which is the same convention `reseat.mjs` uses.

Alphabetical rather than "shift everyone below him up one", because it is reproducible from the roster alone.
Run it twice and the second run is a no-op, which a positional shift cannot promise.
It also means a section that had drifted out of alphabetical order, because somebody was hand-placed at the bottom of it, comes back into order as a side effect.

A commander holds an administrative `00xx` id and no section seat, so posting one out archives him and renumbers nothing.

`--keep-seat` leaves the hole open instead.
Use it when an incoming man is already earmarked for that seat and renumbering the same section twice in a fortnight is the worse outcome.

## What it writes

| | |
|---|---|
| `roster` | his `id` and `4d` re-keyed to the archive key, soft-deleted; then the section's seats re-keyed in two phases |
| every table with a `d4` column | discovered from the catalogue, his rows re-keyed and soft-deleted, the movers' rows re-keyed |
| `auth_tokens`, `invites` | his are re-keyed **and revoked** |
| `people` | his `last_d4` becomes the archive key, and the key is appended to `d4_history` |
| `intake_log` | one row for him (`matched_by = 'depart'`, with what he carried and why), one per man who moved up (`depart-renumber`) |
| `revs` | every tracked tab bumped |

His `people` row is not touched otherwise.
That is the point of the registry: if he comes back, a later changeover matches him on `pid` or on his NRIC digest and re-homes the history this archived.

Revoking his tokens is not housekeeping.
A token left pointing at a bare 4D becomes, the moment somebody moves up into that seat, a departed man's phone reading and writing as the man who replaced him.

`audit` is deliberately left alone.
It records what was written at the time, and rewriting history to match the present is the one thing an audit log must never do.
Historic parade-state snapshots are left alone for the same reason.

## Immediately after

The script prints this list too. It matters.

1. **Bump `STORAGE_KEY` in `js/state.js`** and the uniform `?v=` in `index.html`, then deploy.
   This is what forces every phone to drop its cache.
   The rev bumps stop a stale phone overwriting anything; only dropping the cache stops it acting on the wrong man.
2. **Re-issue invites** for anyone whose 4D moved.
3. His own access is already revoked by the run.

## Reading the archive afterwards

```sql
select * from roster  where "id" like '9404@%';
select * from medical where "d4" like '9404@%';
select * from intake_log where matched_by = 'depart' order by at desc;
```

`person_history` is the view that answers "what has this man done across every intake he has been in", keyed on `pid` rather than on any 4D.

## Why the purge no longer eats this

`purge_retention()` predates archiving and could not tell an archive from a ninety-day-old deletion.
`0007_departures.sql` makes one idea explicit everywhere: a row whose key carries an `@` is archived, whatever cohort it belongs to.

The purge skips those rows and reports how many it skipped, and the two guards `0004` installed against a stale phone (`keep_archived_archived`, `block_archived_delete`) now recognise an archive key as well as a non-current intake stamp.
That second half is what a mid-intake departure needs: his rows carry the **current** intake label, so the cohort test alone never saw him as archived at all.
