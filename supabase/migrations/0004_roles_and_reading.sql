-- ===========================================================================
-- Hope Kitchen web — 0004: who is calling, what each role may do, who reads what
-- ===========================================================================
-- Row Level Security on every table. There are NO insert, update or delete
-- policies at all: a signed-in browser can call PostgREST directly, so the only
-- writes are the doors in 0005 (FQC trap: "if the app enforces a rule, the
-- database must too"). Read policies go through SECURITY DEFINER helpers so no
-- policy reads its own table (FQC trap 42P17).
--
-- Two kinds of session:
--   a manager   auth.uid() = staff.auth_user_id, role director or inventory, active
--   a tablet    auth.uid() = devices.id, active; reads only its own locations
-- Anyone else (anon, a stray auth user) reads nothing.
-- ===========================================================================

-- The manager behind this session, or nothing.
create or replace function me_staff() returns staff
language sql stable security definer set search_path = public as $$
  select s.* from staff s
  where s.auth_user_id = auth.uid() and s.active and s.role in ('director', 'inventory')
$$;

create or replace function is_manager() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.auth_user_id = auth.uid() and s.active and s.role in ('director', 'inventory'))
$$;

create or replace function is_director() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff s where s.auth_user_id = auth.uid() and s.active and s.role = 'director')
$$;

create or replace function is_device() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from devices d where d.id = auth.uid() and d.active)
$$;

-- A manager sees every location; a tablet sees the ones it is tied to.
create or replace function can_see_location(loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_manager() or exists (
    select 1 from device_locations dl join devices d on d.id = dl.device_id
    join locations l on l.id = dl.location_id
    where dl.device_id = auth.uid() and dl.location_id = loc and d.active and l.active)
$$;

-- The Mac app's Perm table (Sources/Store.swift), in SQL. The TypeScript copy in
-- web/src/lib/roles.ts must say the same; tools/test-sql.mjs compares them.
create or replace function has_perm(r staff_role, perm text) returns boolean
language sql immutable as $$
  select case perm
    when 'view'          then true
    when 'loss_report'   then true
    when 'issue'         then r in ('director','inventory','chef','staff')
    when 'request'       then r in ('director','inventory','chef','staff')
    when 'count_entry'   then r in ('director','inventory','chef','staff')
    when 'receive'       then r in ('director','inventory')
    when 'adjust'        then r in ('director','inventory')
    when 'items_edit'    then r in ('director','inventory')
    when 'fulfil'        then r in ('director','inventory')
    when 'reports'       then r in ('director','inventory')
    when 'loss_decide'   then r = 'director'
    when 'people'        then r = 'director'
    else false end
$$;

alter table locations enable row level security;
alter table categories enable row level security;
alter table staff enable row level security;
alter table staff_pins enable row level security;
alter table pin_attempts enable row level security;
alter table devices enable row level security;
alter table device_locations enable row level security;
alter table actor_sessions enable row level security;
alter table items enable row level security;
alter table item_codes enable row level security;
alter table movements enable row level security;
alter table stock_levels enable row level security;
alter table requests enable row level security;
alter table request_lines enable row level security;
alter table losses enable row level security;
alter table counts enable row level security;
alter table count_lines enable row level security;
alter table audit_log enable row level security;

-- The catalogue is for every working session; stock and history by location.
create policy locations_read on locations for select to authenticated using (is_manager() or can_see_location(id));
create policy categories_read on categories for select to authenticated using (is_manager() or is_device());
create policy items_read on items for select to authenticated using (is_manager() or is_device());
create policy item_codes_read on item_codes for select to authenticated using (is_manager() or is_device());
create policy stock_levels_read on stock_levels for select to authenticated using (can_see_location(location_id));
create policy movements_read on movements for select to authenticated using (can_see_location(location_id));
create policy staff_read on staff for select to authenticated using (is_manager());
create policy devices_read on devices for select to authenticated using (is_manager() or id = auth.uid());
create policy device_locations_read on device_locations for select to authenticated using (is_manager() or device_id = auth.uid());
create policy requests_read on requests for select to authenticated using (is_manager() or is_device());
create policy request_lines_read on request_lines for select to authenticated using (is_manager() or is_device());
create policy losses_read on losses for select to authenticated using (can_see_location(location_id));
create policy counts_read on counts for select to authenticated using (can_see_location(location_id));
create policy count_lines_read on count_lines for select to authenticated
  using (exists (select 1 from counts c where c.id = count_id and can_see_location(c.location_id)));
create policy audit_log_read on audit_log for select to authenticated using (is_director());
-- staff_pins, pin_attempts, actor_sessions: no policies at all. Only the doors reach them.

-- The names a tablet shows on its sign-in screen: people who may scan, never managers' emails.
create or replace function tablet_roster()
returns table (id uuid, display_name text, role staff_role, has_pin boolean)
language sql stable security definer set search_path = public as $$
  select s.id, s.display_name, s.role, exists (select 1 from staff_pins p where p.staff_id = s.id)
  from staff s
  where s.active and (is_device() or is_manager())
  order by s.display_name
$$;

-- Supabase hands EXECUTE on every new function to anon by name (FQC 0029/0030): take it back.
revoke all on function me_staff(), is_manager(), is_director(), is_device(), can_see_location(uuid), tablet_roster()
  from public, anon;
grant execute on function me_staff(), is_manager(), is_director(), is_device(), can_see_location(uuid), tablet_roster()
  to authenticated;
revoke all on function has_perm(staff_role, text) from public, anon;
grant execute on function has_perm(staff_role, text) to authenticated;

-- Tables: the browser roles read through RLS and write nothing.
revoke insert, update, delete, truncate on all tables in schema public from anon, authenticated;
revoke all on staff_pins, pin_attempts, actor_sessions from anon, authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 4 $$;

select 'part 0004 applied' as proof,
  (select count(*) from pg_tables where schemaname = 'public' and rowsecurity) as rls_tables,
  has_function_privilege('anon', 'tablet_roster()', 'execute') as anon_can_roster,
  hk_schema_version() as version;
