# Cougar system - notes for agents

Things that are not obvious from the code and have cost time at least once.
Start with [DEV-ENV.md](DEV-ENV.md) to get a real backend running, and
[HANDOFF.md](HANDOFF.md) for the overall shape (note it predates the Postgres
backend and still describes Sheets in places).

## Where the backend actually is

`master` is still the Apps Script + Google Sheets backend.
The Postgres/Supabase backend lives on `feat/supabase-backend` and is where new
backend work belongs.
Check which one you are on before assuming a schema.

## The 4D is a seat, not a person

Digit 1 is the platoon and digit 2 the section (`getPlt`/`getSect` in
`js/helpers.js`), so the whole `1101..4xxx` range is reissued to different people
every intake.
`roster.id` **is** the 4D and **is** the primary key, so two cohorts collide on it.

Anything that reasons about a person across time needs `people.pid`, not the 4D.
See [docs/INTAKE-MIGRATION.md](docs/INTAKE-MIGRATION.md).

## Run things against the real backend before believing them

`scripts/dev-env.sh up` gives a real Postgres, the real Edge Function and the
real frontend with no Docker and no cloud.
This is not optional polish: the intake changeover passed 42 unit tests and then
failed three times in a row on the first real run (a foreign-key ordering
problem, rows inheriting the wrong intake stamp, and commanders left stamped
with the archived cohort).

`scripts/verify.sh` is the gate. It only runs the live Edge Function tests when
it sees a change under `supabase/`, and it looks at **committed** changes, so
brand-new untracked files are invisible to it. Commit, then verify.

### Seeding a reset database

`dev-env.sh reset` drops the auth tokens with everything else, and nothing
re-creates them, so `dev-seed.mjs` then fails with `Unauthorized - invite
required`. It authenticates as `dev-token`; the browser instructions use
`t-demo`. Insert both by hand after a reset:

```sql
insert into auth_tokens (token, person, device_label, expires_at)
values ('dev-token','dev','local', now()+interval '365 days'),
       ('t-demo','dev','local',    now()+interval '365 days')
on conflict (token) do nothing;
```

## Edge Function behaviour that surprises

- **Every upsert ends `deleted_at = null`.** That is deliberate (a
  delete-then-append should revive the row), but it means any code path that
  soft-deletes for a *durable* reason needs a trigger to defend it. See
  `keep_archived_archived` in `0004_intake.sql`.
- **A full-tab write HARD-deletes MSK** before reinserting, because MSK has no
  `id` to diff on. A soft delete does not protect MSK rows; a `before delete`
  trigger does.
- **`dropped_fields` is cached in a module-level variable** for the life of a
  warm instance. Adding a row to it needs a redeploy to take effect.
- **`dropped_fields` doubles as a way to make a column server-owned**: the client
  can still read it (via `api_row`) but `shapeRow` drops it on the way in. That
  is how `roster.pid` and `roster.intake` stay unwritable by any phone.
- **`api_row` returns every real column**, so adding a column to a table puts it
  in every `readAll` response and in anything that copies a row. Set derived
  values *after* copying a source row, not before.

## Personnel data rules

- `*.csv` is gitignored on purpose: real nominal rolls must never land in the
  repo. `docs/nominal-roll-template.csv` is the one exception and is entirely
  invented names.
- Eight roster columns are encrypted at rest (`0002_security.sql`). Do not read
  them into a script unless that script genuinely needs them; matching people by
  name does not.
- NRIC is never stored. Only a **keyed** digest of the last four characters. An
  unkeyed hash is not good enough - the space is about 260k values and is walked
  offline in under a second, so the digest would effectively be the value.

## Names in this dataset

Matching people by name needs an unordered token set, not a string compare:
`TAN WEI MING` and `WEI MING TAN` are the same person, and `BIN` / `S/O` /
`BINTE` carry no information.

Do not trust a loose similarity threshold. The token pool is small (LIM, TAN,
WEI, KAI, JUN), so two shared tokens means very little: `JOSHUA LIM KAI EN`
scores 0.67 against `KAI XIN LIM`. Anything short of an exact match should ask a
human rather than guess, because the thing being guessed at is whose medical
records these are.
