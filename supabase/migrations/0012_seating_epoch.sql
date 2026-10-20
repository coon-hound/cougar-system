-- One version for the meaning of every 4D, independent of per-tab revisions.
-- Shared write locks and exclusive seating changes use the same transaction lock.
create table seating_state (
  singleton boolean primary key default true check (singleton),
  epoch bigint not null default 1 check (epoch > 0)
);
insert into seating_state (singleton) values (true);
alter table seating_state enable row level security;

create function seating_epoch() returns bigint language sql stable
  set search_path = public as $$ select epoch from seating_state where singleton $$;

create function begin_seating_change(expected bigint) returns bigint language plpgsql
  set search_path = public as $$
declare current_epoch bigint;
begin
  perform pg_advisory_xact_lock(6413161608::bigint);
  select epoch into current_epoch from seating_state where singleton for update;
  if expected is null or expected <> current_epoch then
    raise exception 'Seating changed since preview; preview again';
  end if;
  update seating_state set epoch = epoch + 1 where singleton returning epoch into current_epoch;
  return current_epoch;
end
$$;

-- A repair receipt makes a verified manifest idempotent without weakening its
-- preconditions. It contains only a checksum and counts, never personnel values.
create table roster_repairs (
  checksum text primary key,
  applied_at timestamptz not null default now(),
  seat_epoch bigint not null,
  records integer not null
);
alter table roster_repairs enable row level security;
