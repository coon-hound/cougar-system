-- ============================================================================
-- 0008_token_activity.sql — find out what is actually happening to the tokens
--
-- THE PROBLEM THIS MEASURES, NOT SOLVES. Commanders lose access often enough
-- that re-issuing links is routine admin work. Production on 22 Sep 2026:
-- 42 tokens for 25 people in 8 days, six people needing 2-4 tokens for the
-- SAME device_label — and 0 expired, 0 unused beyond a week. So the credential
-- is dying on the device, not on the server. What is NOT known is why, and the
-- obvious answer is wrong: the gaps between a device's successive tokens were
-- 0.0h, 0.2h, 2.4h, 14.5h, then 1.5 to 4.4 days. iOS Safari's 7-day eviction
-- of script-writable storage cannot mint a replacement twelve minutes later.
--
-- WHY A NEW TABLE, WHEN TWO NEARLY ANSWER IT ALREADY
-- --------------------------------------------------
--   * `auth_tokens.last_seen_at` is stamped by check_auth on every request,
--     but it is ONE OVERWRITTEN VALUE. It says when a token was last used and
--     nothing about the shape of how it died. Once overwritten the pattern is
--     gone, so the question cannot be asked retroactively.
--   * `usage_daily.device` (0005) looked like a per-token daily log, since
--     js/telemetry.js derives it as an FNV-1a hash of the auth token. It is
--     not. `ensureStore` only derives that id WHEN IT IS MISSING, so it is
--     written once into localStorage `cougar-usage-v1` and then STICKS across
--     token reissues. Measured: of 42 tokens, exactly ONE hashes to a device
--     present in usage_daily — the only token never reissued. So usage_daily
--     cannot be joined to a token, and the client id is unusable as a
--     per-credential probe.
--
-- That stickiness is worth keeping rather than fixing, because it makes
-- usage_daily a DURABLE PER-BROWSER identity: a reissue on a device whose
-- storage survived produces NO new device id, while a wiped bucket produces
-- one. Measured over 17-21 Sep, 13 tokens were issued and 9 new device ids
-- appeared, which splits the losses into two populations — but at n=13 that is
-- suggestive, not conclusive, which is exactly why this table exists.
--
-- ONE ROW PER TOKEN PER DAY, WRITTEN AS IT HAPPENS
-- ------------------------------------------------
-- Not a scheduled snapshot of auth_tokens. A snapshot needs a scheduler, can
-- only ever see the overwritten `last_seen_at`, and silently records nothing
-- for a day it fails to run. Recording inside check_auth instead means the
-- observation is made by the thing that already knows, keyed on the real
-- token, and a token that goes dark simply stops having rows — its last row IS
-- its last active day. That is the population the client-side instrumentation
-- can never see, because a device that never comes back never reports.
--
-- COST. Gated to at most one write per token per day: check_auth runs on every
-- request including the 20-second revCheck poll, so an ungated insert would be
-- a row per device per 20 seconds. At ~30 devices this table grows by ~30 rows
-- a day and `token_activity_prune` bounds it. Same posture as 0005.
--
-- PRIVACY. (token, day, counter). The token is already the primary key of
-- auth_tokens, so this introduces no identifier that was not already there,
-- and — unlike usage_daily — nothing here crosses the wire to a phone.
-- ============================================================================

create table if not exists token_activity (
  token      text not null,
  day        date not null,
  -- Not a request count: the gate below fires once a day, so this counts the
  -- days the row was touched, which is always 1. Kept so a future ungating
  -- has somewhere to put the number rather than needing a schema change.
  seen       integer not null default 1,
  first_at   timestamptz not null default now(),
  last_at    timestamptz not null default now(),
  primary key (token, day)
);

-- The question is always "which days was this token alive", so token-major.
create index if not exists token_activity_day_idx on token_activity (day desc);

comment on table token_activity is
  'One row per auth token per day it was used, written by check_auth. Exists '
  'to measure how device tokens die: a token that goes dark stops having rows, '
  'which is the one signal no client-side telemetry can report.';

-- ── check_auth, unchanged in contract ───────────────────────────────────────
--
-- Same signature, same three refusal reasons in the same order, same
-- last_seen_at touch. The ONLY addition is the daily activity row, and it is
-- deliberately placed AFTER every refusal path so a revoked or expired token
-- records nothing — this table is a record of successful use, and mixing
-- refused attempts into it would make "was this token alive on day N"
-- unanswerable. Refusals are already the audit log's job (0002).
--
-- WHY THE GATE IS ON last_seen_at AND NOT ON THE INSERT ALONE. `on conflict do
-- nothing` would make the insert harmless but not free: it is still a write,
-- an index probe and WAL on every poll from every device. Testing the date
-- first means the common path does no work at all.
create or replace function check_auth(p_token text)
  returns table (ok boolean, person text, reason text)
  language plpgsql
  set search_path = public
as $$
declare
  r auth_tokens;
begin
  if p_token is null or p_token = '' then
    return query select false, null::text, 'missing'; return;
  end if;

  select * into r from auth_tokens where token = p_token;

  if not found then
    return query select false, null::text, 'unknown'; return;
  elsif r.revoked_at is not null then
    return query select false, r.person, 'revoked'; return;
  elsif r.expires_at <= now() then
    return query select false, r.person, 'expired'; return;
  end if;

  -- First successful use today: record the day. `r` is the row as it was read
  -- BEFORE this request, so this is true exactly once per token per day.
  if r.last_seen_at is null or r.last_seen_at::date < current_date then
    insert into token_activity (token, day)
    values (p_token, current_date)
    on conflict (token, day) do update set last_at = now(), seen = token_activity.seen + 1;
  end if;

  update auth_tokens set last_seen_at = now() where token = p_token;
  return query select true, r.person, 'ok';
end $$;

-- ── Retention ───────────────────────────────────────────────────────────────
--
-- Dry run by default, like purge_retention (0002) and usage_prune (0005).
-- A year is far longer than any question here needs, and the table is ~30 rows
-- a day, so this exists to bound it rather than because it will ever bite.
create or replace function token_activity_prune(
  p_commit boolean default false,
  p_days   integer default 365
) returns jsonb language plpgsql set search_path = public as $$
declare n bigint;
begin
  select count(*) into n from token_activity
   where day < current_date - p_days;
  if p_commit then
    delete from token_activity where day < current_date - p_days;
  end if;
  return jsonb_build_object('token_activity', n, 'committed', p_commit);
end $$;

-- ── The read-out ────────────────────────────────────────────────────────────
--
-- What the question actually looks like: per token, the days it was alive and
-- the gap since. `dark_days` is the discriminator — a token still being used
-- after its replacement was issued was never lost at all, the user was simply
-- in a different browser, and that case is invisible in auth_tokens alone.
--
-- Carries no token: a view over credentials that printed them would be the
-- mistake 0006 exists to avoid. The token's identity here is its person and
-- device, which is what every question is asked in terms of anyway.
create or replace view token_lifecycle as
  select a.person,
         a.d4,
         a.device_label,
         a.issued_at::date                       as issued,
         min(t.day)                              as first_active,
         max(t.day)                              as last_active,
         count(t.day)                            as active_days,
         current_date - max(t.day)               as dark_days,
         a.expires_at::date                      as expires,
         (a.revoked_at is not null)              as revoked,
         a.can_invite
    from auth_tokens a
    left join token_activity t on t.token = a.token
   group by a.token, a.person, a.d4, a.device_label,
            a.issued_at, a.expires_at, a.revoked_at, a.can_invite;

comment on view token_lifecycle is
  'Per-token activity timeline by person and device, carrying no credential. '
  'dark_days is the discriminator: a long-lived token that goes quiet looks '
  'like eviction, one replaced within hours looks like a re-tapped link.';

-- ── Seed today, or the first day measures nothing ───────────────────────────
--
-- Found by rehearsing this against a real local Postgres and then driving the
-- real Edge Function over HTTP: nothing was recorded, and the logic was right.
-- Every live token had ALREADY been seen earlier the same day, so the
-- once-a-day gate correctly declined for the rest of it. On the day this
-- deploys that is a blind spot across the whole fleet, and the first day is the
-- one day somebody will look.
--
-- So seed one row per token from the `last_seen_at` the server already holds.
-- That removes the blind spot and, as a side effect, is the only retroactive
-- data point available anywhere: it is the one day of history that survived
-- being overwritten. `on conflict do nothing` keeps this migration re-runnable.
insert into token_activity (token, day, first_at, last_at)
select token, last_seen_at::date, last_seen_at, last_seen_at
  from auth_tokens
 where last_seen_at is not null
on conflict (token, day) do nothing;

-- Same posture as every other table here: enabled, no policies, service role
-- only. The client never reads this.
alter table token_activity enable row level security;
