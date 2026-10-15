# Verified roster repair

The October reseat exposed a mismatch between a stable person (`people.pid`) and a reusable seat (`roster.id`).
A cached roster action could send an old occupant's entire profile to the new occupant's seat.
The protection and repair are separate deployments: protect writes first, repair only after complete verification.

## Protection and compatibility

Apply `0012_seating_epoch.sql`, deploy the updated Edge Function, then deploy the frontend.
The migration slot skips 0011 because another active branch has claimed it.
The deployed asset version must exceed both production and other pending releases; this branch uses 160 and data cache v9.

Every ordinary data mutation now carries `seatEpoch`, captured when the edit is queued.
Missing or outdated versions receive HTTP 200 with `code:409`, `reason:"SEATING_CHANGED"` and the current version, without any data or revision changes.
Old clients can still read, but must reload the updated frontend to save.
The updated client discards obsolete queues and caches, closes open forms and reloads the authoritative snapshot.
It never retries an old edit under a new version or offers to force it through.

Update operational copies of the reseat, departure and intake scripts before using them again.
Each updated utility checks the version captured before planning and calls `begin_seating_change` inside its transaction.
The exclusive transaction lock prevents API writes from racing the rename.
Direct SQL seating changes must use the same function and transaction.
The Apps Script rollback backend does not implement this protection and must not be used for writes during repair.

## Local proof

```bash
npm test
npm run test:e2e
npm run test:integrity
```

The integrity runner creates its own synthetic Postgres cluster under a private temporary directory.
It starts the real Edge Function, runs the HTTP contract, and tests desktop Chromium and an iPhone viewport.
It also starts the actual pre-fix backend from commit `f316028` to prove that the stale-phone action reproduces corruption.
A missing backend fails the run; these checks cannot silently skip.
Logs remain in the printed temporary directory; failure screenshots and traces are under `test-results`.

## Prepare the incident review

Create a private operational directory outside the public checkout and load production credentials using the established credential file.
Do not use production records to populate a development database or tests.

```bash
node scripts/review-roster.mjs --incident '<exact intake_log timestamp>' --output '<private directory>/review.json' --forms '<authoritative FORMS.csv>'
```

This command uses a read-only transaction.
With an authoritative Forms source it decrypts roster values in memory only to verify field equality; it never prints sensitive values.
Approximate name candidates are ranked, and accepted identities are corroborated by a unique full-NRIC digest or an unambiguous exact token match.
It records every person moved in that transaction, current field fingerprints, candidate name mismatches, audit coverage and linked-record counts.
It works before the protection migration, but its seating version remains null until protection is deployed.
The output is a blocked draft, never an approved repair.

Verify every moved person's roster fields and linked history using authoritative documents and audit history.
Record the source and set `verified:true` for each completed review.
Sensitive audit values are redacted and cannot establish a replacement DOB, address, next-of-kin or medical detail.
Unrecorded batch changes require independent verification.
Keep all verification and replacement values in this private file.

For each damaged record, populate `records` with its table, key, reviewed subject PID, expected raw-row fingerprint and verified field replacements.
The repair supports the roster and the original personnel-linked module tables.
MSK uses its `_pk` because it has no `id`.
A child record's `d4` may be corrected only to the reviewed person's current seat.
Roster IDs, PIDs, intake stamps and archival bookkeeping cannot be changed by this tool.
Add records for affected fields beyond names; the generated draft does not certify them.

Before applying, verify a restorable encrypted backup of the production database.
Keep the backup outside the repository with restrictive permissions.
Prepare the final manifest from a fresh protected snapshot and preserve the valid edits made after the incident.

## Preview and apply

```bash
node scripts/repair-roster.mjs '<private directory>/review.json'
node scripts/repair-roster.mjs '<private directory>/review.json' --apply --checksum '<preview checksum>'
```

Preview is a read-only transaction.
The apply command requires the exact preview checksum, complete reviews of every incident participant and unchanged fingerprints for all reviewed people, their linked history and repaired records.
Any missing verification or changed record aborts the entire transaction.
An exact completed manifest is idempotent through a database receipt.

The transaction changes only listed fields, encrypts sensitive replacements, writes redacted field-level audit history, bumps affected tab revisions and increments the seating version.
It preserves the current seating, legitimate later changes and unaffected history.
No production apply is permitted while any field or linked-record review remains unresolved.

## Acceptance and rollback

Read the roster through the deployed API and authenticated browser after applying.
Check verified field values, correct person-to-seat assignments, incident-created duplicate names and linked history against the manifest.
Confirm the deployed frontend and backend versions and inspect seating-version rejection events for stale devices.

If rollback is necessary, prepare a separately verified inverse manifest from the encrypted backup and the current database fingerprints.
Apply it through the same guarded repair transaction so the seating version increases again.
Do not restore an old seating version, deploy the unprotected backend or replay discarded edits.
