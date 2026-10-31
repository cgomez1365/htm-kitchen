-- ===========================================================================
-- Hope Kitchen web — 0007: what the Admin screens need
-- ===========================================================================
-- CEO 2026-10-30: "the system should be frictionless". So:
--   * a person is added with their PIN in ONE door call (no half-made person);
--   * a Director unlocks a locked-out PIN without knowing it; a right PIN also
--     clears earlier wrong tries (5 wrong in a row locks, not 5 in 15 minutes total);
--   * a tablet is paired with a one-time 8-character code (or its QR), so nobody
--     types or even sees a tablet password. Only the server (service_role) redeems it;
--   * a tablet's locations can be taken away: device_locations gets an active flag,
--     because no record is ever deleted (0002);
--   * every refusal is a plain sentence a Director can act on.
-- ===========================================================================

-- ----------------------------------------------------------- new tables --

alter table device_locations add column active boolean not null default true;

-- A Director's "unlock" for a person locked out by wrong PINs. No policies.
create table pin_unlocks (
  id bigserial primary key,
  staff_id uuid not null references staff (id),
  by_staff uuid not null references staff (id),
  at timestamptz not null default now()
);

-- One-time pairing codes for tablets: only the hash is kept. No policies.
create table device_pairings (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references devices (id),
  code_hash text not null unique,
  created_by uuid not null references staff (id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz,
  closed_how text check (closed_how in ('paired', 'replaced'))
);

alter table pin_unlocks enable row level security;
alter table device_pairings enable row level security;
revoke all on pin_unlocks, device_pairings from anon, authenticated;
revoke all on sequence pin_unlocks_id_seq from anon, authenticated;
create trigger pin_unlocks_no_delete before delete on pin_unlocks for each row execute function refuse_record_deletion();
create trigger pin_unlocks_no_truncate before truncate on pin_unlocks for each statement execute function refuse_record_deletion();
create trigger pin_unlocks_no_update before update on pin_unlocks for each row execute function refuse_record_edit();
create trigger device_pairings_no_delete before delete on device_pairings for each row execute function refuse_record_deletion();
create trigger device_pairings_no_truncate before truncate on device_pairings for each statement execute function refuse_record_deletion();

-- A switched-off link no longer shows the location to that tablet.
create or replace function can_see_location(loc uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select is_manager() or exists (
    select 1 from device_locations dl join devices d on d.id = dl.device_id
    join locations l on l.id = dl.location_id
    where dl.device_id = auth.uid() and dl.location_id = loc and dl.active and d.active and l.active)
$$;

-- ------------------------------------------------------------------ PINs --

-- Wrong tries that count toward the lock: the last 15 minutes, but only since the
-- latest right PIN, new PIN or Director unlock.
create or replace function pin_fail_count(p_staff uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from pin_attempts a
  where a.staff_id = p_staff and not a.ok and a.at > greatest(
    now() - interval '15 minutes',
    coalesce((select max(x.at) from pin_attempts x where x.staff_id = p_staff and x.ok), '-infinity'),
    coalesce((select p.set_at from staff_pins p where p.staff_id = p_staff), '-infinity'),
    coalesce((select max(u.at) from pin_unlocks u where u.staff_id = p_staff), '-infinity'))
$$;

create or replace function tablet_sign_in(p_staff uuid, p_pin text,
  out token text, out expires_at timestamptz, out display_name text, out role staff_role,
  out refused boolean, out locked boolean, out reason text)
language plpgsql security definer set search_path = public as $$
declare s staff; h text;
begin
  refused := true; locked := false;
  if not is_device() then reason := 'Only a kitchen tablet signs people in this way.'; return; end if;
  select * into s from staff where id = p_staff and active;
  if not found then reason := 'That person is not active.'; return; end if;
  if pin_fail_count(p_staff) >= 5 then locked := true; reason := 'Too many wrong PINs. Wait 15 minutes or ask a Director to unlock you.'; return; end if;
  select pin_hash into h from staff_pins where staff_id = p_staff;
  if h is null then reason := 'No PIN is set for this person yet. A Director sets it.'; return; end if;
  if p_pin is null or crypt(p_pin, h) <> h then
    insert into pin_attempts (staff_id, device_id, ok) values (p_staff, auth.uid(), false);
    perform write_audit(p_staff, auth.uid(), 'pin.wrong', 'staff', p_staff::text, '{}');
    reason := 'Wrong PIN.'; return;
  end if;
  insert into pin_attempts (staff_id, device_id, ok) values (p_staff, auth.uid(), true);
  token := encode(gen_random_bytes(24), 'hex');
  expires_at := now() + interval '12 hours';
  insert into actor_sessions (token_hash, staff_id, device_id, expires_at)
  values (encode(digest(token, 'sha256'), 'hex'), p_staff, auth.uid(), expires_at);
  perform write_audit(p_staff, auth.uid(), 'pin.sign_in', 'staff', p_staff::text, '{}');
  display_name := s.display_name; role := s.role; refused := false;
end $$;

create or replace function unlock_pin(p_staff uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare me staff;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director unlocks PINs.'; end if;
  insert into pin_unlocks (staff_id, by_staff) values (p_staff, me.id);
  perform write_audit(me.id, null, 'pin.unlocked', 'staff', p_staff::text, '{}');
  return true;
end $$;

-- ---------------------------------------------------------------- people --

-- One call adds or edits a person, PIN included. Switching someone off ends their
-- tablet sessions at once. Changing a manager's email unlinks the old sign-in.
create or replace function save_staff(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me staff; sid uuid := nullif(p->>'id', '')::uuid; r staff_role := nullif(p->>'role', '')::staff_role;
  nm text := trim(coalesce(p->>'display_name', '')); act boolean := coalesce((p->>'active')::boolean, true);
  em text := lower(nullif(trim(coalesce(p->>'email', '')), '')); pin text := nullif(trim(coalesce(p->>'pin', '')), '');
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director manages people.'; end if;
  if nm = '' or length(nm) > 80 then raise exception 'Type the person''s name (up to 80 letters).'; end if;
  if r is null then raise exception 'Pick a role.'; end if;
  if r not in ('director', 'inventory') then em := null; end if;
  if r in ('director', 'inventory') and em is null then raise exception 'A manager needs an email: it is how they sign in.'; end if;
  if em is not null and em !~ '^[^@\s]+@[^@\s]+$' then raise exception 'That email does not look right.'; end if;
  if em is not null and exists (select 1 from staff where lower(email) = em and id is distinct from sid) then
    raise exception 'Someone else already uses %.', em;
  end if;
  if act and exists (select 1 from staff where active and lower(display_name) = lower(nm) and id is distinct from sid) then
    raise exception 'Someone active is already called %. Add a last initial so the tablet tells them apart.', nm;
  end if;
  if pin is not null and pin !~ '^[0-9]{4,8}$' then raise exception 'A PIN is 4 to 8 digits.'; end if;
  if sid is null then
    insert into staff (display_name, role, email, active, created_by) values (nm, r, em, act, me.id) returning id into sid;
    perform write_audit(me.id, null, 'staff.added', 'staff', sid::text, jsonb_build_object('role', r));
  else
    if not exists (select 1 from staff where id = sid) then raise exception 'That person is not on the list.'; end if;
    if sid = me.id and (r <> 'director' or not act) then
      raise exception 'You can''t remove your own Director access. Another Director has to.';
    end if;
    update staff set display_name = nm, role = r, active = act,
      auth_user_id = case when email is distinct from em then null else auth_user_id end, email = em
    where id = sid;
    if not act then update actor_sessions set ended_at = now() where staff_id = sid and ended_at is null; end if;
    perform write_audit(me.id, null, 'staff.updated', 'staff', sid::text, jsonb_build_object('role', r, 'active', act));
  end if;
  if pin is not null then
    insert into staff_pins (staff_id, pin_hash, set_by) values (sid, crypt(pin, gen_salt('bf', 8)), me.id)
    on conflict (staff_id) do update set pin_hash = excluded.pin_hash, set_at = now(), set_by = excluded.set_by;
    perform write_audit(me.id, null, 'pin.set', 'staff', sid::text, '{}');
  end if;
  return sid;
end $$;

create or replace function people_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me staff;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director manages people.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', s.id, 'display_name', s.display_name, 'role', s.role, 'email', s.email, 'active', s.active,
      'linked', s.auth_user_id is not null, 'is_me', s.id = me.id,
      'has_pin', p.staff_id is not null, 'pin_set_at', p.set_at, 'locked', pin_fail_count(s.id) >= 5,
      'on_tablet', exists (select 1 from actor_sessions a where a.staff_id = s.id and a.ended_at is null and a.expires_at > now()),
      'last_scan', (select max(m.recorded_at) from movements m where m.actor_id = s.id))
    order by s.active desc, s.display_name)
    from staff s left join staff_pins p on p.staff_id = s.id), '[]');
end $$;

-- --------------------------------------------------------------- tablets --

create or replace function save_device(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  me staff; did uuid := nullif(p->>'id', '')::uuid; act boolean := coalesce((p->>'active')::boolean, true);
  nm text := trim(coalesce(p->>'name', '')); locs uuid[];
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director manages tablets.'; end if;
  if did is null or not exists (select 1 from devices where id = did) then raise exception 'That tablet is not registered.'; end if;
  if nm = '' then raise exception 'Give the tablet a name.'; end if;
  if exists (select 1 from devices where lower(name) = lower(nm) and id <> did) then raise exception 'Another tablet is already called %.', nm; end if;
  select coalesce(array_agg(x::uuid), '{}') into locs from jsonb_array_elements_text(coalesce(p->'locations', '[]')) x;
  update devices set name = nm, active = act where id = did;
  update device_locations set active = (location_id = any(locs)) where device_id = did;
  insert into device_locations (device_id, location_id) select did, l from unnest(locs) l
  on conflict (device_id, location_id) do update set active = true;
  if not act then update actor_sessions set ended_at = now() where device_id = did and ended_at is null; end if;
  perform write_audit(me.id, null, 'device.saved', 'devices', did::text, jsonb_build_object('name', nm, 'active', act, 'locations', locs));
  return did;
end $$;

create or replace function tablet_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare me staff;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director manages tablets.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', d.id, 'name', d.name, 'active', d.active, 'email', u.email,
      'locations', coalesce((select jsonb_agg(dl.location_id) from device_locations dl where dl.device_id = d.id and dl.active), '[]'),
      'last_seen', (select max(m.recorded_at) from movements m where m.device_id = d.id),
      'people_on', (select count(*) from actor_sessions a where a.device_id = d.id and a.ended_at is null and a.expires_at > now()),
      'pairing_until', (select max(dp.expires_at) from device_pairings dp where dp.device_id = d.id and dp.closed_at is null and dp.expires_at > now()),
      'paired_at', (select max(dp.closed_at) from device_pairings dp where dp.device_id = d.id and dp.closed_how = 'paired'))
    order by d.active desc, d.name)
    from devices d left join auth.users u on u.id = d.id), '[]');
end $$;

-- A fresh code replaces any open one for that tablet. 32 letters and digits with the
-- look-alikes (I, O, 0, 1) left out; 8 of them is about 10^12 codes, open 15 minutes.
create or replace function start_pairing(p_device uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  me staff; alpha text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea := gen_random_bytes(8);
  c text := ''; i int; exp timestamptz := now() + interval '15 minutes';
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director pairs tablets.'; end if;
  if not exists (select 1 from devices where id = p_device and active) then raise exception 'That tablet is switched off. Switch it on first.'; end if;
  for i in 0..7 loop c := c || substr(alpha, get_byte(b, i) % 32 + 1, 1); end loop;
  update device_pairings set closed_at = now(), closed_how = 'replaced' where device_id = p_device and closed_at is null;
  insert into device_pairings (device_id, code_hash, created_by, expires_at)
  values (p_device, encode(digest(c, 'sha256'), 'hex'), me.id, exp);
  perform write_audit(me.id, null, 'device.pairing_started', 'devices', p_device::text, '{}');
  return jsonb_build_object('code', c, 'expires_at', exp);
end $$;

-- The server alone (service_role) trades a code for the tablet's sign-in, then gives
-- the tablet a fresh password it never shows. A wrong, used or expired code answers nothing.
create or replace function redeem_pairing(p_code text) returns table (device_id uuid, email text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare pr device_pairings;
  h text := encode(digest(upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g')), 'sha256'), 'hex');
begin
  select * into pr from device_pairings dp where dp.code_hash = h and dp.closed_at is null and dp.expires_at > now() for update;
  if not found or not exists (select 1 from devices d where d.id = pr.device_id and d.active) then return; end if;
  update device_pairings dp set closed_at = now(), closed_how = 'paired' where dp.id = pr.id;
  perform write_audit(null, pr.device_id, 'device.paired', 'devices', pr.device_id::text, '{}');
  return query select pr.device_id, u.email::text from auth.users u where u.id = pr.device_id;
end $$;

-- ------------------------------------------------------------- locations --

create or replace function save_location(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare me staff; lid uuid := nullif(p->>'id', '')::uuid; act boolean := coalesce((p->>'active')::boolean, true);
  nm text := trim(coalesce(p->>'name', ''));
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director edits locations.'; end if;
  if nm = '' or length(nm) > 80 then raise exception 'Give the location a name (up to 80 letters).'; end if;
  if exists (select 1 from locations where lower(name) = lower(nm) and id is distinct from lid) then
    raise exception 'There is already a location called %.', nm;
  end if;
  if lid is null then
    insert into locations (name, kind) values (nm, coalesce(nullif(p->>'kind', ''), 'storage')::location_kind) returning id into lid;
  else
    if not act and exists (select 1 from stock_levels where location_id = lid and on_hand <> 0) then
      raise exception 'Stock is still recorded there. Move or count it to zero before closing.';
    end if;
    update locations set name = nm, kind = coalesce(nullif(p->>'kind', ''), 'storage')::location_kind, active = act where id = lid;
  end if;
  perform write_audit(me.id, null, 'location.saved', 'locations', lid::text, p);
  return lid;
end $$;

create or replace function location_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_manager() then raise exception 'Only a manager sees every location.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'id', l.id, 'name', l.name, 'kind', l.kind, 'active', l.active,
      'stocked', (select count(*) from stock_levels sl where sl.location_id = l.id and sl.on_hand <> 0),
      'tablets', (select count(*) from device_locations dl join devices d on d.id = dl.device_id
                  where dl.location_id = l.id and dl.active and d.active))
    order by l.active desc, l.created_at) from locations l), '[]');
end $$;

-- ------------------------------------------------------------ categories --

-- p.original is the current name when editing. A name items already use stays (they
-- point at it); its prefix can change, and next_sku() counts by prefix, so no SKU repeats.
create or replace function save_category(p jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare me staff; orig text := nullif(trim(coalesce(p->>'original', '')), '');
  nm text := trim(coalesce(p->>'name', '')); px text := upper(trim(coalesce(p->>'prefix', '')));
  act boolean := coalesce((p->>'active')::boolean, true);
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director edits categories.'; end if;
  if nm = '' or length(nm) > 60 then raise exception 'Give the category a name (up to 60 letters).'; end if;
  if px !~ '^[A-Z]{2,5}$' then raise exception 'A prefix is 2 to 5 capital letters, like DRY.'; end if;
  if exists (select 1 from categories where prefix = px and name is distinct from orig) then raise exception 'The prefix % is already used.', px; end if;
  if exists (select 1 from categories where lower(name) = lower(nm) and name is distinct from orig) then
    raise exception 'There is already a category called %.', nm;
  end if;
  if orig is null then
    insert into categories (name, prefix, active) values (nm, px, act);
  else
    if not exists (select 1 from categories where name = orig) then raise exception 'That category is not on the list.'; end if;
    if nm <> orig and exists (select 1 from items where category = orig) then
      raise exception 'Items already use the name %, so it stays. You can still change its prefix or switch it off.', orig;
    end if;
    update categories set name = nm, prefix = px, active = act where name = orig;
  end if;
  perform write_audit(me.id, null, 'category.saved', 'categories', nm, p);
  return nm;
end $$;

create or replace function category_list() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_manager() then raise exception 'Only a manager edits categories.'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'name', c.name, 'prefix', c.prefix, 'active', c.active,
      'items', (select count(*) from items i where i.category = c.name), 'next_sku', next_sku(c.name))
    order by c.active desc, c.name) from categories c), '[]');
end $$;

-- The names the Items screen offers (active only). Invoker: RLS lets managers and tablets read.
create or replace function category_names() returns setof text
language sql stable set search_path = public as $$ select name from categories where active order by name $$;

-- ---------------------------------------------------------------- grants --

revoke all on function pin_fail_count(uuid) from public, anon, authenticated;
revoke all on function redeem_pairing(text) from public, anon, authenticated;
grant execute on function redeem_pairing(text) to service_role;
revoke all on function unlock_pin(uuid), people_list(), save_device(jsonb), tablet_list(), start_pairing(uuid),
  location_list(), save_category(jsonb), category_list(), category_names() from public, anon;
grant execute on function unlock_pin(uuid), people_list(), save_device(jsonb), tablet_list(), start_pairing(uuid),
  location_list(), save_category(jsonb), category_list(), category_names() to authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 7 $$;

select 'part 0007 applied' as proof,
  has_function_privilege('authenticated', 'redeem_pairing(text)', 'execute') as session_can_redeem,
  has_function_privilege('anon', 'start_pairing(uuid)', 'execute') as anon_can_pair,
  hk_schema_version() as version;
