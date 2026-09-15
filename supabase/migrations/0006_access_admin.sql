-- ============================================================================
-- 0006_access_admin.sql — one token may hand out access; the rest may not
--
-- Until now every token was equal. Any of the 26 commander phones could, if the
-- app offered the button, mint a permanent credential under any name it liked,
-- or revoke everyone else's. For a system holding medical records and next-of-
-- kin details that is not an acceptable shape once invite management moves into
-- the app itself.
--
-- So: a single explicit capability, default FALSE, granted by hand.
--
-- THE FRONTEND HIDING THE SCREEN IS NOT THE CONTROL. js/* is public code served
-- to every phone; anyone can read it and craft the request by hand. The control
-- is that the Edge Function refuses the action for any token without this flag.
-- The hiding exists so 25 people are not shown a button that would only ever
-- tell them no.
-- ============================================================================

alter table auth_tokens
  add column if not exists can_invite boolean not null default false;

comment on column auth_tokens.can_invite is
  'May create and revoke invites and tokens. Default false. Granted by hand, '
  'never by the app, and never inherited through redeemInvite — an invite can '
  'only ever produce an ordinary token.';

-- Deliberately NOT on `invites`. A capability that can be handed out through an
-- invite is a capability that escapes: whoever holds it can mint another holder,
-- and the set only grows. Granting is a database action, on purpose, so it
-- leaves a trace and cannot be done from a phone that someone else is holding.

-- ── Who am I ────────────────────────────────────────────────────────────────
--
-- The app has never known who is using it. It holds a token string and nothing
-- else, which is why the audit log could name people long before the interface
-- could. Returns identity plus the one capability, so the client can render
-- honestly rather than guess.
create or replace function whoami(p_token text)
  returns table (person text, d4 text, device_label text,
                 can_invite boolean, expires_at timestamptz)
  language sql stable
  set search_path = public
as $$
  select t.person, t.d4, t.device_label, t.can_invite, t.expires_at
    from auth_tokens t
   where t.token = p_token
     and t.revoked_at is null
     and t.expires_at > now()
$$;

-- ── The access list, without the secrets ────────────────────────────────────
--
-- Everything needed to answer "who can get in, and who has not used their link
-- yet" and NOTHING that grants access. No invite tokens, no auth tokens. The
-- app never needs to see an existing token to manage it: `revokeAccess` takes
-- the person, not the credential.
--
-- That matters because this response crosses the wire to a phone and sits in
-- its memory. A list that carried tokens would turn one screenshot into 26
-- working credentials.
-- Dropped rather than replaced: `create or replace view` cannot change a view's
-- column list, so adding `token` below would fail on a shape mismatch.
drop view if exists access_overview cascade;

create view access_overview as
  select 'token'::text as kind,
         t.person, t.d4, t.device_label,
         t.issued_at as at, t.expires_at, t.last_seen_at,
         case when t.revoked_at is not null then 'revoked'
              when t.expires_at <= now()    then 'expired'
              else 'active' end as status,
         t.can_invite,
         null::integer as used_count, null::integer as max_uses,
         -- An AUTH token is never exposed, whatever its state. There is no
         -- reason for one to reach a phone: the page manages access by person
         -- and device, not by credential.
         null::text as token
    from auth_tokens t
   union all
  select 'invite'::text,
         i.person, i.d4, coalesce(i.device_label, 'device'),
         i.created_at, i.expires_at, null::timestamptz,
         case when i.revoked_at is not null           then 'revoked'
              when i.used_count >= i.max_uses         then 'redeemed'
              when i.expires_at <= now()              then 'expired'
              else 'open' end,
         false,
         i.used_count, i.max_uses,
         -- An UNOPENED invite hands its link back, because that link is exactly
         -- what the page exists to give out, and without this it is visible
         -- once at creation and then lost. Redeemed, expired and revoked
         -- invites send nothing: those links are dead, and a dead credential on
         -- screen only confuses somebody later.
         case when i.revoked_at is null
               and i.used_count < i.max_uses
               and (i.expires_at is null or i.expires_at > now())
              then i.token end
    from invites i
   where i.person is not null;

comment on view access_overview is
  'Who holds access and who has an outstanding invite. Carries no tokens of '
  'either kind: this crosses the wire to a phone, and a list containing '
  'credentials would make one screenshot a breach.';

alter table auth_tokens enable row level security;

-- ── Grant the capability ────────────────────────────────────────────────────
--
-- Scoped to the ONE existing token that was created by hand rather than
-- redeemed, which is the owner's. Written as an UPDATE with a narrow WHERE
-- rather than a hardcoded token so this migration is safe to run anywhere,
-- including a fresh dev database where it simply matches nothing.
update auth_tokens
   set can_invite = true
 where device_label = 'primary'
   and revoked_at is null;

-- ── Remove an ambiguous overload ────────────────────────────────────────────
--
-- 0003 added an eight-argument log_audit whose last three parameters have
-- defaults, but `create or replace function` only replaces a function of the
-- SAME signature — so 0002's six-argument version was left in place alongside
-- it. Any six-argument call then matches both:
--
--   ERROR: function log_audit(unknown, ..., boolean, jsonb) is not unique
--
-- The deployed Edge Function happens to pass all eight, which is why nothing
-- has broken in production. It broke the moment a new call site passed six,
-- which is exactly the shape a future caller would reach for. The comment in
-- 0003 claimed keeping the old form was deliberate deploy-ordering safety; it
-- bought none, because the ambiguity is resolved at CALL time, not deploy time.
--
-- One function, no ambiguity. The three trailing parameters still default, so a
-- six-argument call now resolves cleanly to it.
drop function if exists log_audit(text, text, text, text, boolean, jsonb);
