# Promoting the company

The runbook for the day a cohort's posting comes through and its rank changes.

This is not a change of intake and not a re-sectioning.
The men are the same and their seats are the same; only `roster.rank` moves.
For a whole new cohort see [INTAKE-MIGRATION.md](INTAKE-MIGRATION.md), and for re-dealing a platoon's seats see [RESEAT.md](RESEAT.md).

## Why this needs a tool at all

Not because the `UPDATE` is hard.
Because of what sits either side of it.

**`role` and `rank` are different fields, and only one of them moves.**
`role` is the two-valued Commander / Recruit switch that about twenty call sites scope on.
`rank` is REC, PTE, 3SG.
A promotion is a thing that happens to the enlistee cohort, so the filter is on `role` - and a tool that scoped on rank instead would catch the command body and rewrite a 3SG to PTE.
That demotion would then render on every parade state the company files, and nothing downstream would flag it, because every surface would agree with every other surface.

**A blank rank is not the same as no opinion.**
`rosterRank()` in `js/forms.js` falls back to `REC` for a blank column, which is what every row looked like before the column carried anything.
So a row that is blank and a row that says REC are the same man on screen, and both are a man who has not been promoted yet.
The tool treats them identically.

**Any other rank already in the column is somebody who already moved.**
Writing PTE over an LCP is a demotion.
Those rows stop the run and are listed by 4D, and `--force` is the operator saying "yes, those too".

## The run

Preview first. It reads and writes nothing, and you can run it as often as you like.

```bash
export DATABASE_URL=...        # the Supabase connection string

node scripts/promote.mjs
```

Names are **not** printed unless you add `--names`, so the report is safe to paste into a chat.

```
Intake: 16/26
PROMOTE - every enlistee to PTE

  18 commander(s) - untouched, always.
  14 enlistee(s) already PTE.
  82 enlistee(s) would change.

    7101  (blank) -> PTE
    7102  REC -> PTE
    ...

READY
```

Read the report. When it says `READY`, run it again with `--apply`.
It is one transaction: if anything fails, nothing is committed.

```bash
node scripts/promote.mjs --apply
```

It is idempotent.
A row already holding the target rank is not a write, so a second run reports nothing to do and commits nothing.
That is what makes a half-finished run safe to repeat.

## Options

| | |
|---|---|
| `--apply` | actually write. Without it the run is a preview. |
| `--names` | print names in the report. Off by default; the report gets pasted into chats. |
| `--rank X` | target some rank other than PTE. Must be one of the enlistee ranks. |
| `--force` | also promote enlistees already holding some other rank. Read the blocked list first. |

## What it writes

| | |
|---|---|
| `roster` | `rank`, for non-Commander rows of the current intake only |
| `revs` | `Roster` bumped, so every phone in the field pulls the new column |

Nothing else.
The 4D did not move, so no child table is touched, no invite needs re-issuing, and `STORAGE_KEY` does not need bumping - a stale phone holding the old rank is showing an out-of-date rank, not acting on the wrong man.

## Immediately after

1. Bump the uniform `?v=` in `index.html` and deploy, if a frontend change ships with it.
2. Nothing else. Reload a phone and check the parade state says PTE.
