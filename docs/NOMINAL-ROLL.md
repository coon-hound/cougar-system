# Nominal roll format

What the system needs when a new intake arrives, and how to give it to it.

This page is safe to forward to whoever produces the roll.
It describes a file, not the system that reads it.

## The short version

One CSV file.
One row per enlistee.
Headers in row 1.

Two columns are required: **4D** and **Name**.
Everything else is optional and only makes the result better.

If all you can get is those two columns, the changeover still works.

```csv
4D,Name
1101,TAN WEI MING
1102,MUHAMMAD DANIAL BIN RAZAK
1103,RAJU S/O MANICKAM
```

`docs/nominal-roll-template.csv` is a filled-in example with every supported column.

## The columns

### Required

| Column | What it is | Notes |
|---|---|---|
| `4D` | The four-digit seat the enlistee will hold | Digit 1 is the platoon, digit 2 is the section, so `1101` is Platoon 1, Section 1. Must be four digits and must not start with `00` (that range belongs to commanders). Must be unique within the file. |
| `Name` | Full name as per official records | Order does not matter, see below. |

### Worth chasing

| Column | Why it earns its place |
|---|---|
| `NRIC` | The single most valuable optional column. It is what makes recognising a returning enlistee exact instead of a name comparison. Only a one-way digest of it is used, and the raw value is never stored anywhere. See [What happens to the NRIC](#what-happens-to-the-nric). |
| `Rank` | Defaults to `REC` if absent. |
| `Phone` | Used for contact and for the Telegram bot. |
| `Date of Birth`, `Blood Type`, `Allergies`, `Other Medical` | Shown on the profile card and relevant in an emergency. Encrypted at rest. |
| `NOK Name`, `NOK Relation`, `NOK Phone` | Next of kin. Encrypted at rest. |
| `Address`, `Email`, `Height`, `Weight`, `Ration` | Filled in if present, ignored if not. |
| `PID` | Only ever filled in by us, to settle an ambiguous match. Leave it blank. |

Any column not in this list is ignored, and the run reports which ones it skipped.
So an HQ roll with vocation codes, bunk numbers and parent occupations can be handed over exactly as received.
Nothing extra is stored.

### Header spellings

Headers are matched with case and punctuation ignored, and common variants are accepted.
All of these are read as the 4D column:

```
4D    4d    4D No    4D Number    ID    Recruit ID    Seat
```

Likewise `Name` / `Full Name` / `Name of Personnel` / `NRIC Name`, and `HP` / `Mobile` / `Contact No` for the phone.
There is no need to rename anything by hand.
If a column you care about is being skipped, say so and an alias gets added.

## Names

Names are compared as an unordered set of parts, so the same person is recognised however the roll happens to record them.

`TAN WEI MING` and `WEI MING TAN` are the same person.

Particles that carry no identifying information are ignored, so these pairs also match:

```
MUHAMMAD BIN ALI      =  MUHAMMAD B. ALI
RAJU S/O MANICKAM     =  RAJU MANICKAM
SITI BINTE AHMAD      =  SITI AHMAD
```

A name that is close but not identical does **not** get matched automatically.
`JOSHUA LIM KAI EN` against a known `KAI XIN LIM` shares two parts and nothing more, and two shared parts means very little when the whole company is drawn from LIM, TAN, WEI, KAI and JUN.
Those cases stop the run and ask for a decision rather than guessing, because the thing being guessed at is whose medical records these are.

The fix is always the same: put the right `PID` in that row, or `NEW` if it is a different person.
The report prints the exact line to use.

## File format

- **CSV**, UTF-8. Commas inside quoted fields are fine, as are quotes inside quotes.
- **Excel is fine too**, just save as CSV first (`File > Save As > CSV UTF-8`).
- Headers in **row 1**. No title rows, no merged cells above the header, no blank leading columns.
- Blank rows are skipped, so trailing empty rows do no harm.
- Dates in any column are read as either `16 May 2026` or `2026-05-16`.

The one thing that will waste your time is a spreadsheet where the real header is on row 4 under a unit crest and a classification banner.
Delete the rows above the header before exporting.

## What happens to the NRIC

The NRIC is used for one purpose: matching a returning enlistee to the person we already have records for.

It is never stored.

The whole NRIC is used, and only as the input to a keyed one-way digest.
What is kept is the digest, which cannot be reversed without a secret key held outside the database.
The raw value does not reach the database, the archive, the audit log, or the run's own output.
There is a test that fails the build if it ever appears anywhere in the plan.

Send the **full** value or leave the column blank.
A partial NRIC is no use here: the last four characters are three digits and a checksum letter, and among a single intake of 96 enlistees two separate pairs of people shared theirs.
A roll carrying only suffixes keys nothing and falls back to matching on names.

If the roll cannot carry an NRIC, nothing breaks.
Matching falls back to names, which works, and the run will ask about anything it is not sure of.

## A worked example

```csv
4D,Name,Rank,NRIC,HP,Date of Birth,Blood Type,NOK Name,NOK Phone,Vocation Code
1101,TAN WEI MING,REC,S0512345A,91110001,03 Apr 2007,O+,MEI LING TAN,92220001,X11
1102,MUHAMMAD DANIAL BIN RAZAK,REC,,91110002,11 Jun 2007,A+,RAZAK BIN SALIM,92220002,X12
1201,RAJU S/O MANICKAM,REC,,91110003,02 Feb 2007,B+,MANICKAM RAJU,92220003,X13
```

`Vocation Code` is not a column the system knows.
It gets skipped, the run says so, and nothing about it is stored.

## What to send back

Just the file.

Say which intake it is (for example `26/02`) and the cohort's first day in camp.
Those two facts are what the records get labelled with, and they are what makes the previous intake findable a year later.
