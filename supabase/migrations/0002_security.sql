-- ============================================================================
-- 0002_security.sql — hardening (plan §4)
--
-- Ships WITH the migration, before cutover, so the new backend is never run in
-- the old posture: one shared never-expiring token, checked for presence only
-- (apps-script-Code.gs:297), guarding an endpoint deployed "Who has access:
-- Anyone" (SETUP.md:88), over data held in a personal Google account.
--
-- Adds: an audit trail, encryption at rest for the sensitive column set, the
-- dropped-field deny-list, and retention.
--
-- ORDERING: this migration converts Roster columns to bytea and MUST run
-- before the import. The guard below refuses to run against a populated
-- roster rather than quietly destroying data.
-- ============================================================================

do $$
begin
  if exists (select 1 from roster limit 1) then
    raise exception
      '0002 converts roster columns to bytea and must run BEFORE the import; roster already has rows';
  end if;
end $$;

-- ── Encryption at rest ──────────────────────────────────────────────────────
--
-- The key lives in the Edge Function's environment and is passed per query. It
-- is never stored in the database, so a dump on its own does not decrypt — that
-- is the property being bought here, and it is why these are functions taking
-- p_key rather than a key kept in a table.
--
-- pgp_sym_encrypt is NON-DETERMINISTIC (random IV per call), so these columns
-- cannot be indexed, searched or sorted. Verified safe: all eight are
-- display-only on the profile card (js/forms.js:101-125), and the only filters
-- in the app are role/plt/sect/program/group (js/state.js:226-236).

-- VOLATILE (the default), not IMMUTABLE: pgp_sym_encrypt uses a random IV per
-- call, so marking this immutable would let the planner constant-fold it.
create or replace function enc_col(p_val text, p_key text) returns bytea
  language sql strict as $$
    select pgp_sym_encrypt(p_val, p_key, 'compress-algo=0, cipher-algo=aes256')
$$;

-- Deliberately NOT exception-safe: a wrong or missing key must fail loudly
-- rather than silently yielding blanks that a full-tab write would then
-- persist over the real values.
create or replace function dec_col(p_val bytea, p_key text) returns text
  language sql strict immutable as $$
    select pgp_sym_decrypt(p_val, p_key)
$$;

alter table roster
  alter column "dob"          type bytea using null::bytea,
  alter column "bloodType"    type bytea using null::bytea,
  alter column "allergies"    type bytea using null::bytea,
  alter column "otherMedical" type bytea using null::bytea,
  alter column "address"      type bytea using null::bytea,
  alter column "nokName"      type bytea using null::bytea,
  alter column "nokRelation"  type bytea using null::bytea,
  alter column "nokPhone"     type bytea using null::bytea;

-- Decrypting accessor. Returns the same key set as api_row() would, so
-- responses stay byte-identical to the Sheets backend: empty cells came back
-- as "" there, so nulls are coalesced to "" here rather than dropped.
create or replace function roster_api_row(r roster, p_key text) returns jsonb
  language sql stable as $$
    select (api_row(to_jsonb(r))
             - 'dob' - 'bloodType' - 'allergies' - 'otherMedical'
             - 'address' - 'nokName' - 'nokRelation' - 'nokPhone')
           || jsonb_build_object(
                'dob',          coalesce(dec_col(r."dob",          p_key), ''),
                'bloodType',    coalesce(dec_col(r."bloodType",    p_key), ''),
                'allergies',    coalesce(dec_col(r."allergies",    p_key), ''),
                'otherMedical', coalesce(dec_col(r."otherMedical", p_key), ''),
                'address',      coalesce(dec_col(r."address",      p_key), ''),
                'nokName',      coalesce(dec_col(r."nokName",      p_key), ''),
                'nokRelation',  coalesce(dec_col(r."nokRelation",  p_key), ''),
                'nokPhone',     coalesce(dec_col(r."nokPhone",     p_key), '')
              )
$$;

-- ── Dropped-field deny-list (plan §4.6) ─────────────────────────────────────
--
-- These columns are not created in 0001. Without an explicit deny-list they
-- would simply reaccumulate inside `extra` on the next full-tab write, so the
-- Edge Function and the importer both strip anything listed here. Kept as a
-- table so there is exactly one definition of the list.
create table dropped_fields (
  tab    text not null,
  field  text not null,
  reason text,
  primary key (tab, field)
);

insert into dropped_fields (tab, field, reason) values
  ('Roster', 'gpa',           'display-only on profile card; drives no decision'),
  ('Roster', 'fieldOfStudy',  'display-only on profile card; drives no decision'),
  ('Roster', 'smoker',        'display-only on profile card; drives no decision'),
  ('Roster', 'nokOccupation', 'display-only on profile card; drives no decision');

-- ── Audit trail ─────────────────────────────────────────────────────────────
--
-- The old backend had no attribution of any kind: every write arrived as an
-- anonymous valid token. One row per mutating request.
create table audit (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  token     text,
  person    text,
  action    text,
  tab       text,
  row_id    text,
  ok        boolean,
  detail    jsonb not null default '{}'::jsonb
);

create index audit_at_idx  on audit (at desc);
create index audit_row_idx on audit (tab, row_id);

create or replace function log_audit(
  p_token  text,
  p_action text,
  p_tab    text,
  p_row_id text,
  p_ok     boolean,
  p_detail jsonb default '{}'::jsonb
) returns void language sql as $$
  insert into audit (token, person, action, tab, row_id, ok, detail)
  select p_token,
         (select person from auth_tokens where token = p_token),
         p_action, p_tab, p_row_id, p_ok, p_detail
$$;

-- ── Token validation ────────────────────────────────────────────────────────
--
-- Replaces isValidAuth (apps-script-Code.gs:297), which was a bare presence
-- check on a script property: no identity, no expiry, no revocation.
-- Returns a reason rather than a bare boolean so the function can distinguish
-- "expired" from "revoked" from "never existed" in the audit log — while still
-- returning the same opaque {error, code:401} to the client.
create or replace function check_auth(p_token text)
  returns table (ok boolean, person text, reason text)
  language plpgsql as $$
declare r auth_tokens;
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

  update auth_tokens set last_seen_at = now() where token = p_token;
  return query select true, r.person, 'ok';
end $$;

-- ── Retention ───────────────────────────────────────────────────────────────
--
-- NOTE ON POSTED-OUT PERSONNEL: the plan called for purging them, but there is
-- no field to key that on. Roster."status" is a MEDICAL status — its live
-- values are LD, MC, Active, NIL, Excuse RMJ, Pending, Excuse Heavy Load and
-- similar — not a posting status, and nothing else in the schema records a
-- departure. So the rule implemented here is: removing someone from the roster
-- soft-deletes them, and this purge hard-deletes them (and their now-orphaned
-- records) once the retention window has passed. No new column, no guessing.
--
-- DRY RUN BY DEFAULT. This function deletes personnel and medical records, so
-- it reports counts and changes nothing unless p_commit is explicitly true.
create or replace function purge_retention(
  p_commit             boolean default false,
  p_soft_delete_days   integer default 90,
  p_snapshot_days      integer default 365,
  p_audit_days         integer default 730
) returns jsonb language plpgsql as $$
declare
  result   jsonb := '{}'::jsonb;
  n        bigint;
  t        text;
  gone     text[];
  child    text;
begin
  -- 1. Roster rows soft-deleted longer ago than the window.
  select array_agg("id") into gone
    from roster
   where deleted_at is not null
     and deleted_at < now() - make_interval(days => p_soft_delete_days);
  gone := coalesce(gone, '{}');
  result := result || jsonb_build_object('roster', cardinality(gone));

  -- 2. Their records in every d4-keyed child table.
  foreach child in array array[
    'medical','ippt','routemarch','soc','polarflow','conductdetail',
    'appointments','leave','msk','reportsick','tgusers'
  ] loop
    execute format('select count(*) from %I where "d4" = any($1)', child)
      into n using gone;
    result := result || jsonb_build_object(child, n);
    if p_commit and cardinality(gone) > 0 then
      execute format('delete from %I where "d4" = any($1)', child) using gone;
    end if;
  end loop;

  if p_commit and cardinality(gone) > 0 then
    delete from roster where "id" = any(gone);
  end if;

  -- 3. Soft-deleted rows in every other table, past the same window.
  foreach t in array array[
    'medical','attendance','ippt','routemarch','soc','polarflow',
    'conductdetail','appointments','leave','msk','conducts',
    'paradestates','tgusers','reportsick'
  ] loop
    execute format(
      'select count(*) from %I where deleted_at is not null
         and deleted_at < now() - make_interval(days => $1)', t)
      into n using p_soft_delete_days;
    result := result || jsonb_build_object(t || '_soft_deleted', n);
    if p_commit then
      execute format(
        'delete from %I where deleted_at is not null
           and deleted_at < now() - make_interval(days => $1)', t)
        using p_soft_delete_days;
    end if;
  end loop;

  -- 4. Parade snapshots. savedAt is epoch milliseconds held as text, so the
  --    cast is guarded and falls back to the row's own insert time.
  select count(*) into n from paradestates
   where (case when "savedAt" ~ '^\d+$'
               then to_timestamp(("savedAt")::bigint / 1000.0)
               else updated_at end) < now() - make_interval(days => p_snapshot_days);
  result := result || jsonb_build_object('paradestates_aged', n);
  if p_commit then
    delete from paradestates
     where (case when "savedAt" ~ '^\d+$'
                 then to_timestamp(("savedAt")::bigint / 1000.0)
                 else updated_at end) < now() - make_interval(days => p_snapshot_days);
  end if;

  -- 5. Audit trim.
  select count(*) into n from audit where at < now() - make_interval(days => p_audit_days);
  result := result || jsonb_build_object('audit', n);
  if p_commit then
    delete from audit where at < now() - make_interval(days => p_audit_days);
  end if;

  return result || jsonb_build_object('committed', p_commit);
end $$;

-- ── RLS on the new tables ───────────────────────────────────────────────────
-- Same posture as 0001: enabled, no policies, service role only.
alter table dropped_fields enable row level security;
alter table audit          enable row level security;
