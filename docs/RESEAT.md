# Re-sectioning a platoon

The runbook for the day a platoon is dealt into different sections - crewing up
for unit training, or any reshuffle that moves men between sections.

This is **not** a change of intake.
The men are the same; only their seats move.
For a whole new cohort see [INTAKE-MIGRATION.md](INTAKE-MIGRATION.md).

## Why this needs a tool at all

A 4D is a seat, not a person.
Digit 1 is the platoon, digit 2 the section, and the last two are his place in that section.
So re-sectioning a platoon necessarily re-issues its 4Ds, and `roster.id` **is** the 4D and **is** the primary key.

Three things make that harder than an `UPDATE`.

**The rename overlaps itself.**
The seat a man is moving out of is usually one another man is moving into.
A single statement re-keying `9301` to `9102` trips the primary key the moment it reaches the first row, even though the set as a whole is a clean permutation.
So the rename goes through a temporary key in two phases, inside one transaction.

**Every child table joins on the 4D.**
Medical, IPPT, route march, MSK, appointments, leave and the rest all key on it.
A table the rename misses silently detaches that man's history - and medical history detaches at exactly the moment it matters most.
The tool reads the list of tables **out of the catalogue** rather than carrying one in its source, because a list in the source is precisely how a table gets forgotten.

**The phones in the field still hold the old seating.**
Nothing looks stale - the same men are there - so nothing prompts a commander to reload.
Meanwhile his phone will happily write a row against a 4D that now belongs to somebody else.

## The run

Write the new sections into a plain text file, exactly as they come out of the chat.
Keep that file **outside this repository**: it carries real names, and this repository is public.

```
SECTION 1 — 9
HU CHEN — 🔵 Hunter Driver
HO SAM HIN, JAYDEN — 🟢 AI
...
```

Preview first. It reads and writes nothing, and you can run it as often as you like.

```bash
export DATABASE_URL=...        # the Supabase connection string

node scripts/reseat.mjs ~/.cougar-reseat/plt9.txt --plt 9
```

Names are **not** printed unless you add `--names`, so the report is safe to paste into a chat.

Read the report, then work the blocking list until it is empty.

When it ends in `READY`, run it again with `--apply`.
It is one transaction: if anything fails, nothing is committed.

## What it refuses to do

The list must account for **the whole platoon, one-to-one**.
Anyone on the roster but not on the list, anyone on the list twice, or any name that is not an exact match stops the run.

That strictness is the safety property, not pedantry.
The failure mode of a loose matcher is one recruit silently inheriting another man's medical history, which nothing downstream will ever flag.

Near misses are **ranked but never accepted**.
The report prints the candidates with a similarity score and the exact line to add:

```
  ✗ line 8: no recruit in platoon 9 is named "AHMAD BAHAGGI BIN JURAIMI".
      9101  79%  AHMAD BAIHAQQI BIN JURAIMI
      ...
      if that is him, change the line to:  AHMAD BAHAGGI BIN JURAIMI [9101]
```

A trailing `[4D]` pins that line to that roster row.
Pin only after reading the candidates - that pin is you saying "yes, this is that man".

Where the list and the roster disagree on a **spelling**, the roster wins.
Section lists are typed by hand; the roster row is the record of who the person is.

## Why alphabetical

The sequence within a section is alphabetical by name, not the order the list happens to be in.

Those lists are written in appointment order - drivers, then gunners, then troopers - and that order changes with every vehicle reshuffle.
Numbering from it would churn every man's 4D each time somebody swapped seats in a Hunter.
Alphabetical is stable, reproducible from the roster alone, and leaves a section whose membership did not change holding exactly the numbers it already had.

## Immediately after

The script prints this list too. It matters.

1. **Bump `STORAGE_KEY` in `js/state.js`** and the uniform `?v=` in `index.html`, then deploy.
   This is what forces every phone to drop its cache.
   The rev bumps stop a stale phone overwriting anything; only dropping the cache stops it acting on the wrong man.

2. **Re-issue invites** for anyone whose 4D moved.

3. If ranks changed with the posting, set `roster.rank` too.
   The parade state, the MSK report and the fitness report all read rank off the roster and fall back to `REC` only when it is blank.

## What it writes

| | |
|---|---|
| `roster` | `id` and `4d`, in two phases |
| every table with a `d4` column | discovered from the catalogue, scoped to the current intake |
| `people` | `last_d4`, and the new seat appended to `d4_history` |
| `intake_log` | one row per man moved, `matched_by = 'reseat'`, with what he carried |
| `revs` | every tracked tab bumped |

`audit` is deliberately left alone.
It records what was written at the time, and rewriting history to match the present is the one thing an audit log must never do.

Historic parade-state snapshots are left alone for the same reason: they are the record of a particular morning, and that morning's 4Ds were what they were.
