-- A staged name repair can precede the Edge Function rollout. This guard
-- rejects a stale whole-profile write even through the pre-epoch backend.
-- Values are registered by the private repair manifest, never by a phone.
create table roster_name_guards (
  pid text primary key references people(pid),
  expected_name text not null check (length(trim(expected_name)) > 0),
  verified_at timestamptz not null default now()
);
alter table roster_name_guards enable row level security;

create function guard_verified_roster_name() returns trigger language plpgsql
  security definer set search_path = public as $$
declare expected text;
begin
  select expected_name into expected from roster_name_guards where pid = new.pid;
  if found and new.name is distinct from expected then
    raise exception using errcode = '23514',
      message = 'Verified roster name changed; refresh the roster before saving';
  end if;
  return new;
end
$$;
create trigger roster_verified_name before insert or update of name, pid on roster
  for each row execute function guard_verified_roster_name();
