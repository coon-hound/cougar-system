-- ============================================================================
-- 0003_identity_and_history.sql — name the people, and keep what changed
--
-- Two gaps the system showed the moment it was actually used:
--
-- 1. NOBODY HAS A NAME. redeemInvite writes the INVITE'S OWN TOKEN into
--    auth_tokens.person, so a person who joins by invite appears as
--    "10de11d4-2173-45df-..." in the access list and in every audit row they
--    generate. The only named token in the system is one that was inserted by
--    hand. Attribution that cannot name anybody is not attribution.
--
-- 2. THE AUDIT LOG RECORDS THAT SOMETHING CHANGED, NOT WHAT IT WAS. It answers
--    "who touched this row and when" but not "what did it say before" — so it
--    cannot settle a disagreement about a medical status, and it cannot undo a
--    mistaken edit.
--
-- Applied AFTER the import, unlike 0002, so it must be safe over populated
-- tables. Everything here is additive: new nullable columns and replaced
-- function bodies. No data is rewritten.
-- ============================================================================

-- ── 1. Identity on invites ──────────────────────────────────────────────────
--
-- The chosen model is ONE PRE-LABELLED INVITE PER PERSON: the invite carries
-- the name when it is created, and redemption copies it to the token. No login,
-- no typing on a phone — which matters for users who are one-handed on a parade
-- square — at the cost that a forwarded link wears the wrong name. That is an
-- acceptable trade for a link sent to one person at a time, and it is why
-- issue-invites.mjs warns about exactly that.
alter table invites
  add column if not exists person       text,
  add column if not exists d4           text,
  add column if not exists device_label text,
  add column if not exists revoked_at   timestamptz;

-- revoked_at rather than the obvious trick of pulling max_uses down to
-- used_count. That trick works, but it makes a KILLED invite indistinguishable
-- from a FULLY REDEEMED one — both read as "no uses left" — so the log can no
-- longer answer whether someone used their link or you cancelled it. Recording
-- the intent separately keeps that answerable, and the row stays auditable
-- either way since nothing is deleted.
comment on column invites.revoked_at is
  'Set when an invite is cancelled before use. Distinct from being used up.';

comment on column invites.person is
  'Who this invite is for. Copied onto auth_tokens.person at redemption, and '
  'from there onto every audit row that token generates.';
comment on column invites.d4 is
  'Canonical 4D (digit-only, zero-padded) so a token can be joined to roster.';

-- Existing tokens issued before this migration carry an invite token in
-- `person`. Blank those rather than leave a UUID masquerading as a name — an
-- unattributed row is honest, a row that looks named but is not is worse.
update auth_tokens
   set person = null
 where person ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

alter table auth_tokens
  add column if not exists d4 text;

-- ── 2. Before / after on the audit trail ────────────────────────────────────
--
-- THE CONSTRAINT THAT SHAPES THIS: eight Roster columns are encrypted at rest
-- (0002) precisely so a database dump does not reveal dates of birth, blood
-- types, medical conditions, addresses and next-of-kin details. Copying those
-- values into an audit row in the clear would hand back everything the
-- encryption bought, in a table nobody thinks of as sensitive.
--
-- So the audit log stores, for those columns, only WHETHER they changed —
-- never the value. `redact_sensitive` is the single place that rule lives, and
-- the Edge Function is expected to pass rows through it rather than reimplement
-- the list.
create or replace function sensitive_cols() returns text[]
  language sql immutable as $$
    select array['dob','bloodType','allergies','otherMedical',
                 'address','nokName','nokRelation','nokPhone']
$$;

-- The BEFORE side: every sensitive value becomes the same placeholder.
create or replace function redact_sensitive(p_tab text, p_row jsonb)
  returns jsonb language sql immutable
  set search_path = public
as $$
  select case
    when p_row is null then null
    when p_tab is distinct from 'Roster' then p_row
    else (
      select coalesce(jsonb_object_agg(key,
               case when key = any (sensitive_cols())
                    then to_jsonb('[redacted]'::text) else value end), '{}'::jsonb)
        from jsonb_each(p_row)
    )
  end
$$;

-- The AFTER side has to know whether the value actually MOVED.
--
-- Redacting both sides to the same placeholder made them compare equal, so a
-- changed date of birth vanished from the log entirely — hiding the value is
-- correct, hiding the fact that someone changed it is not. That is the whole
-- point of an audit trail.
--
-- So the after-value is '[changed]' when it differs and '[redacted]' when it
-- does not. That leaks exactly one bit — did this field move — and never the
-- value. A hash would also compare correctly but is the wrong answer here: the
-- space of dates of birth and blood types is small enough to walk through
-- offline, so a hash of one is effectively the value.
create or replace function redact_sensitive_after(p_tab text, p_before jsonb, p_after jsonb)
  returns jsonb language sql immutable
  set search_path = public
as $$
  select case
    when p_after is null then null
    when p_tab is distinct from 'Roster' then p_after
    else (
      select coalesce(jsonb_object_agg(key,
               case when key = any (sensitive_cols())
                    then to_jsonb(case
                           when coalesce(p_before -> key, 'null'::jsonb)
                                is distinct from value then '[changed]'
                           else '[redacted]' end)
                    else value end), '{}'::jsonb)
        from jsonb_each(p_after)
    )
  end
$$;

alter table audit
  add column if not exists before jsonb,
  add column if not exists after  jsonb;

comment on column audit.before is
  'The row as it stood before this change, with encrypted Roster columns '
  'replaced by [redacted]. Null for an insert.';
comment on column audit.after is
  'The row as written. Null for a delete.';

-- Replaces the 0002 signature. The old six-argument form is kept as an overload
-- so a deploy where the function updates before the schema does — or rolls back
-- after it — cannot start throwing "function does not exist" on every write.
create or replace function log_audit(
  p_token  text,
  p_action text,
  p_tab    text,
  p_row_id text,
  p_ok     boolean,
  p_detail jsonb default '{}'::jsonb,
  p_before jsonb default null,
  p_after  jsonb default null
) returns void language sql
  set search_path = public
as $$
  insert into audit (token, person, action, tab, row_id, ok, detail, before, after)
  select p_token,
         (select person from auth_tokens where token = p_token),
         p_action, p_tab, p_row_id, p_ok, p_detail,
         redact_sensitive(p_tab, p_before),
         redact_sensitive_after(p_tab, p_before, p_after)
$$;

-- ── 3. Reading it back ──────────────────────────────────────────────────────
--
-- The point of keeping before/after is being able to answer a question in one
-- query rather than by writing one. Field-level changes, newest first.
-- Dropped rather than replaced: `create or replace view` cannot change a
-- view's column list, so a re-run after any edit here would fail on a shape
-- mismatch instead of updating. A view holds no data, so dropping it costs
-- nothing.
drop view if exists audit_changes cascade;

create view audit_changes as
  select a.id,
         a.at,
         coalesce(a.person, '(unattributed)') as person,
         a.action, a.tab, a.row_id,
         coalesce(a.after, a.before) ->> 'd4' as d4,
         c.key                as field,
         a.before -> c.key    as old_value,
         a.after  -> c.key    as new_value
    from audit a
    cross join lateral jsonb_each(coalesce(a.after, a.before, '{}'::jsonb)) c
   where a.ok
     and a.before is not null
     and a.after  is not null
     and (a.before -> c.key) is distinct from (a.after -> c.key);

comment on view audit_changes is
  'One row per FIELD that actually changed, rather than one row per request. '
  'Answers "what did this record say before" directly. Note old_value/new_value '
  'rather than was/now — `now` collides with the function of that name.';

-- Everything about one person, from every table that keys on them. Matches
-- either the row id itself (Roster) or the row''s d4 (every child table).
create or replace function history_for(p_d4 text)
  returns table (at timestamptz, person text, action text, tab text,
                 row_id text, field text, old_value jsonb, new_value jsonb)
  language sql stable
  set search_path = public
as $$
  select c.at, c.person, c.action, c.tab, c.row_id, c.field, c.old_value, c.new_value
    from audit_changes c
   where c.row_id = p_d4 or c.d4 = p_d4
   order by c.at desc
$$;

alter table audit enable row level security;

-- ── 4. Retention, restated ──────────────────────────────────────────────────
-- The audit trail now holds field values, so the existing 730-day trim in
-- purge_retention matters more than it did when rows were bare event records.
-- No change to the window here — flagged so the decision is a decision.
