# IPPT import - screenshots to the IPPT tab, at 100% accuracy

This is the runbook for getting a set of IPPT results into the app.
It replaces the BMT-era procedure (scanned score-sheet PDFs, hand-kept tracker) for the Keat Hong phase, where results arrive as phone screenshots of the IPPT app's "DETAIL n" screens.

The bar is 100% accuracy.
It is reached by redundant mechanical checks, not by care: every number must survive two independent reads and a closed-set name match before a single row is written, and every result's stations are cross-checked against its printed score.

**The score printed on the screenshot is the single truth.** It is what gets written, always. The scoring tables are used only to cross-check the station reads, never to replace or "correct" a score.

## What the IPPT tab expects

- Every IPPT row carries a `series`: `KH` (Keat Hong, the current phase) or `BMT` (the five BMT IPPTs, 26 May - 13 Aug 2026).
  Rows written before the field existed have none; `ipptSeriesOf` in `js/helpers.js` dates them (before 14 Sep 2026 is BMT).
- `attempt` restarts per series: the first IPPT at Keat Hong is KH 1, not IPPT 6.
  An IPPT is identified by (series, attempt), never by the attempt number alone.
- The tab leads with KH. BMT is one collapsed card at the bottom that opens into the same full analytics.
- Commanders are not tracked in the IPPT tab. Their results are on the detail lists and are excluded (and reported) on import.

## Inputs

| Input | Notes |
|---|---|
| Screenshots | The IPPT app's DETAIL 1..n screens, scrolled so every row appears whole in at least one shot. Overlap between shots is good: overlapping rows are cross-checked. |
| Test date | The screenshots do not show it. Confirm it with whoever sent them. |
| KH attempt number | How many IPPTs the company has taken at Keat Hong, including this one. |
| Live roster | Read from the database by the script. |

## Stage A - the working folder

Put the screenshots in a folder at the repo root named `ipptKH<n>/` (for example `ipptKH1/`).
It is gitignored along with every `*.jpeg`: the screenshots and everything written next to them pair names with 4Ds, and this repository is public.

Screenshots saved out of WhatsApp carry a `com.apple.macl` tag, and macOS refuses to let a terminal read them ("Operation not permitted" on a file you can see).
Give the terminal Full Disk Access (System Settings > Privacy & Security), then restart it.

## Stage B - the blind visual read

A model reads every screenshot visually and transcribes every row it sees into `<folder>/visual.json`.
It must NOT see the OCR output: the value of this read is that it is independent.
Rows repeated across screenshots are transcribed each time they appear.

One object per row appearance:

```json
{"shot":"s01","detail":1,"idx":1,"rank":"PTE","name":"ALPHA ONE BIN BRAVO","pu":"56","su":"50","run":"12:02","tag":"394","pts":"78","cut":null,"unsure":null}
```

- Column order on screen is push-ups, sit-ups, run. The BMT score sheets were sit-ups first; do not carry that habit over.
- `"-"` for a station not done, `"Not Registered"` for the tag of a man who did not register, `null` for anything not visible.
- `cut` is `"top"` or `"bottom"` for a row clipped by the screen edge. Never record a value read from clipped glyphs.
- Also note where each detail list visibly ends. The last shot of a detail should show blank space below its last row; if it does not, get another screenshot.

## Stage C - the script

```bash
DATABASE_URL=... node scripts/ippt-import.mjs ipptKH1 --attempt 1 --date "23 Sep 2026"
```

It does the rest, and writes nothing to the database without `--apply`:

1. OCRs every screenshot with Apple Vision (`scripts/ippt-ocr.swift`, compiled on first use) and parses the boxes into rows.
2. Re-reads, from enlarged crops, any cell the full-screen OCR returned nothing for.
   Vision drops a lone narrow glyph ("41", "51") far more often than it misreads one; a crop value is accepted only when at least two crop sizes read the same thing and none read anything else.
3. Reconciles the two reads. A field is accepted only when every appearance, in both sources, reads the same.
   A clipped appearance vouches for nothing it may have lost. One source reading `-` where the other read no text at all is agreement that there is no number.
4. Checks coverage: every detail must run 1..N with no gaps.
5. The scoring cross-check: each result's push-ups, sit-ups and run time are scored with `js/ippt-scoring.js` (age groups 1-3) and compared with the printed total.
   A mismatch prints `CHECK` and does not stop the run: the printed score is written regardless, and the check is a prompt to look at that row's station reads on the screenshot once more.
6. Matches every name to the live roster by exact unordered token set, ignoring `BIN`/`S/O`/punctuation. Anything short of exact stops the run with ranked candidates.
7. Prints the closed set: every enlistee on the roster is either a result, a "not registered", or "on no list".
8. Writes `<folder>/reconciled.json` and `<folder>/ippt_DDMMYY_verification.csv` (the audit trail, with each man's tag for later recounts).

Any read disagreement, coverage gap or unmatched name prints `STOPPED` and exits non-zero.
Fix the cause (usually: look at the screenshot, correct `visual.json` if the visual read was wrong, or get a better screenshot) and run again.

### Names

The names in the IPPT app are the official ones.
When a sheet name differs from the roster only in spelling (`ZULFIKAR` vs `ZULFIQAR`) or punctuation (a missing comma before an English name), correct the ROSTER to the app's spelling, in the `roster` row and its `people` row (`name` and `name_key = person_name_key(name)`), then `bump_rev('Roster')`.
Confirm the spelling against the OCR as well as the visual read before writing it.
A man who genuinely is not the roster man is a different matter: never pin a near miss you have not confirmed.
`--pin 3:14=7105` (detail 3, row 14 is 4D 7105) exists for the case where the roster cannot be corrected first.

### What gets written

| Sheet row | Written as |
|---|---|
| A result | `pushups`, `situps`, `runTime` as printed, `score` = the printed total |
| Registered but no station done (`- - -`, 0 pts) | `0 / 0 / 0:00 / 0`, which the app shows as YTT |
| Not Registered | nothing; the man appears in the YTT chase list |
| A commander (3SG, 2SG, 2LT, ...) | nothing, listed as excluded |
| A man who has left (archived with `-out-`) | nothing, listed as excluded |

Row ids are `ippt-<series><attempt>-<4D>`, so a second `--apply` of the same import rewrites the same rows instead of adding new ones.
A different result already stored for the same man and IPPT is a conflict: the run stops unless `--replace` is passed.

## Stage D - apply

```bash
DATABASE_URL=... node scripts/ippt-import.mjs ipptKH1 --attempt 1 --date "23 Sep 2026" --apply
```

One transaction, then `bump_rev('IPPT')` so every phone pulls the new rows on its next poll.
Deploy the frontend that knows about `series` BEFORE the first KH import, or phones on the old build show KH 1 beside BMT 1 as one "IPPT 1".

## Recounts

When the conducting staff recount a station, find the man by his tag in the verification CSV, then edit his row in the app (IPPT tab, the pencil on his row).
The recounted score from the conducting staff (or the IPPT app, once they update it) is the truth: enter it as given, together with the recounted station.
The form can pre-fill a computed score only when the roster holds the man's age; if it does, overwrite it with the official one.

## Why each check exists

- Two reads, not one: on the KH 1 screenshots Vision OCR silently dropped four push-up counts, and the one visual read could not be checked against anything. Together they left four cells for a targeted re-read and nothing else.
- The scoring cross-check: a station misread has to fool both reads identically AND land on a combination that scores the same printed total to go unflagged. On KH 1 all 98 results re-derived their printed score. Building it also caught that the app's own sit-up table was the push-up table, and that its run lookup rounded 12:02 into the 11:51-12:00 band.
- Age groups 1-3: the screen does not show age group. KH 1 needed AG3 for one man (25/53/14:08 = 60).
- The closed set: nobody on the roster may vanish from an import silently.
