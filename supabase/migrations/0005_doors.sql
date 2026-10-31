-- ===========================================================================
-- Hope Kitchen web — 0005: the doors
-- ===========================================================================
-- The only ways to write. Each is SECURITY DEFINER, checks who is calling and
-- what that role may do, and writes the audit row in the same transaction.
--
-- Two FQC rules shape every door:
--   * A refusal is ANSWERED AS A ROW, never raised (FQC trap): a raise would roll
--     back the audit row with it, so refused tries would leave no trace.
--     The web app turns refused = true into a 400 (stop, show the reason).
--   * A scan's id is made on the device. Sending the same scan twice (offline
--     queue retry) answers duplicate = true and changes nothing.
-- ===========================================================================

create type door_result as (id uuid, duplicate boolean, refused boolean, reason text, flag text, here numeric, total numeric);

create or replace function stock_here(p_item uuid, p_location uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select on_hand from stock_levels where item_id = p_item and location_id = p_location), 0)
$$;

create or replace function stock_total(p_item uuid) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce((select sum(on_hand) from stock_levels where item_id = p_item), 0)
$$;

create or replace function write_audit(p_actor uuid, p_device uuid, p_action text, p_entity text, p_entity_id text, p_detail jsonb)
returns void language sql security definer set search_path = public as $$
  insert into audit_log (actor_id, device_id, session_user_id, action, entity, entity_id, detail)
  values (p_actor, p_device, auth.uid(), p_action, p_entity, p_entity_id, coalesce(p_detail, '{}'))
$$;

-- Who is acting: the manager behind the session, or the person unlocked on this tablet
-- with their PIN at the moment the scan was made (p_at), so a scan queued offline
-- still counts if the person was signed in when they made it.
create or replace function resolve_actor(p_token text, p_at timestamptz,
  out actor_id uuid, out actor_role staff_role, out device_id uuid, out problem text)
language plpgsql stable security definer set search_path = public as $$
declare m staff; s record;
begin
  if p_at is null or p_at > now() + interval '5 minutes' or p_at < now() - interval '24 hours' then
    problem := 'The scan time is off by more than allowed. Check the tablet clock.'; return;
  end if;
  select * into m from me_staff();
  if m.id is not null then actor_id := m.id; actor_role := m.role; return; end if;
  if not is_device() then problem := 'Sign in first.'; return; end if;
  device_id := auth.uid();
  if p_token is null or length(p_token) < 20 then problem := 'Tap your name and enter your PIN first.'; return; end if;
  select a.staff_id, st.role into s
  from actor_sessions a join staff st on st.id = a.staff_id
  where a.token_hash = encode(digest(p_token, 'sha256'), 'hex') and a.device_id = auth.uid() and st.active
    and p_at >= a.started_at - interval '5 minutes' and p_at <= coalesce(a.ended_at, a.expires_at);
  if not found then problem := 'Your sign-in on this tablet has ended. Enter your PIN again.'; return; end if;
  actor_id := s.staff_id; actor_role := s.role;
end $$;

-- What happens when someone takes out more than the system shows at that location.
-- Mirrors shortfallDecision in Sources/Store.swift, which is still the open decision:
-- change both together. Until it is decided, it refuses.
create or replace function shortfall_decision(p_on_hand numeric, p_requested numeric, p_role staff_role, p_kind text,
  out decision text, out message text)
language sql immutable as $$
  select 'block'::text,
    format('Only %s on hand, so %s can''t come out. Count the shelf first.', trim_scale(p_on_hand), trim_scale(p_requested))
$$;

create or replace function refused(p_actor uuid, p_device uuid, p_action text, p_entity_id text, p_reason text)
returns door_result language plpgsql security definer set search_path = public as $$
begin
  perform write_audit(p_actor, p_device, 'refused.' || p_action, 'movements', p_entity_id, jsonb_build_object('reason', p_reason));
  return (null::uuid, false, true, p_reason, null::text, null::numeric, null::numeric)::door_result;
end $$;

-- Locks one level so two tablets cannot both take the last case.
create or replace function lock_level(p_item uuid, p_location uuid) returns numeric
language plpgsql security definer set search_path = public as $$
declare have numeric;
begin
  insert into stock_levels (item_id, location_id) values (p_item, p_location) on conflict do nothing;
  select on_hand into have from stock_levels where item_id = p_item and location_id = p_location for update;
  return have;
end $$;

-- ----------------------------------------------------------------- scans --

create or replace function record_move(p_id uuid, p_token text, p_at timestamptz, p_item uuid, p_location uuid,
  p_kind text, p_qty numeric, p_reason text default null, p_note text default null, p_ref text default null)
returns door_result language plpgsql security definer set search_path = public as $$
declare a record; it items; ex movements; loc locations; delta numeric; have numeric; d record; perm text; fl text;
begin
  select * into ex from movements where id = p_id;
  if found then
    if ex.item_id = p_item and ex.location_id = p_location and ex.kind::text = p_kind then
      return (p_id, true, false, null, ex.flag, stock_here(p_item, p_location), stock_total(p_item))::door_result;
    end if;
    return refused(null, null, 'move', p_id::text, 'That scan id was already used for a different scan.');
  end if;
  select * into a from resolve_actor(p_token, p_at);
  if a.problem is not null then return refused(a.actor_id, a.device_id, 'move', p_item::text, a.problem); end if;
  if p_kind is null or p_kind not in ('receive', 'issue', 'return', 'adjust') then
    return refused(a.actor_id, a.device_id, 'move', p_item::text, 'Unknown movement type.');
  end if;
  perm := case p_kind when 'receive' then 'receive' when 'adjust' then 'adjust' else 'issue' end;
  if not has_perm(a.actor_role, perm) then
    return refused(a.actor_id, a.device_id, 'move', p_item::text, initcap(a.actor_role::text) || ' accounts can''t do that.');
  end if;
  select * into loc from locations where id = p_location;
  if not found or not loc.active or not can_see_location(p_location) then
    return refused(a.actor_id, a.device_id, 'move', p_item::text, 'This tablet can''t move stock at that location.');
  end if;
  select * into it from items where id = p_item;
  if not found or not it.active then return refused(a.actor_id, a.device_id, 'move', p_item::text, 'That item is not active.'); end if;
  if p_qty is null or p_qty = 0 then return refused(a.actor_id, a.device_id, 'move', p_item::text, 'Enter a quantity.'); end if;
  if p_kind <> 'adjust' and p_qty < 0 then return refused(a.actor_id, a.device_id, 'move', p_item::text, 'Enter the quantity as a positive number.'); end if;
  if p_kind = 'adjust' and coalesce(trim(p_note), '') = '' then return refused(a.actor_id, a.device_id, 'move', p_item::text, 'An adjustment needs a note saying why.'); end if;
  delta := case when p_kind = 'issue' then -p_qty else p_qty end;
  have := lock_level(p_item, p_location);
  if delta < 0 and have + delta < 0 then
    select * into d from shortfall_decision(have, -delta, a.actor_role, p_kind);
    if d.decision = 'block' then return refused(a.actor_id, a.device_id, 'move', p_item::text, d.message); end if;
    if d.decision = 'flag' then fl := d.message; end if;
  end if;
  insert into movements (id, item_id, location_id, qty, kind, reason, note, ref, actor_id, device_id, session_user_id, flag, happened_at)
  values (p_id, p_item, p_location, delta, p_kind::movement_kind, p_reason, p_note, p_ref, a.actor_id, a.device_id, auth.uid(), fl, p_at);
  perform write_audit(a.actor_id, a.device_id, 'stock.' || p_kind, 'movements', p_id::text,
    jsonb_build_object('sku', it.sku, 'qty', delta, 'location', p_location));
  return (p_id, false, false, null, fl, stock_here(p_item, p_location), stock_total(p_item))::door_result;
end $$;

create or replace function record_transfer(p_id uuid, p_id_in uuid, p_token text, p_at timestamptz, p_item uuid,
  p_from uuid, p_to uuid, p_qty numeric, p_note text default null)
returns door_result language plpgsql security definer set search_path = public as $$
declare a record; it items; lf locations; lt locations; have numeric; d record; fl text; r text;
begin
  if exists (select 1 from movements where id = p_id) then
    return (p_id, true, false, null, null, stock_here(p_item, p_from), stock_total(p_item))::door_result;
  end if;
  select * into a from resolve_actor(p_token, p_at);
  if a.problem is not null then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, a.problem); end if;
  if not has_perm(a.actor_role, 'issue') then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, 'This role can''t move stock.'); end if;
  if p_from = p_to then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, 'Pick two different locations.'); end if;
  select * into lf from locations where id = p_from;
  select * into lt from locations where id = p_to;
  if lf.id is null or lt.id is null or not lf.active or not lt.active or not can_see_location(p_from) then
    return refused(a.actor_id, a.device_id, 'transfer', p_item::text, 'This tablet can''t move stock from there.');
  end if;
  select * into it from items where id = p_item;
  if not found or not it.active then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, 'That item is not active.'); end if;
  if p_qty is null or p_qty <= 0 then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, 'Enter how much is moving.'); end if;
  have := lock_level(p_item, p_from);
  if have - p_qty < 0 then
    select * into d from shortfall_decision(have, p_qty, a.actor_role, 'transfer');
    if d.decision = 'block' then return refused(a.actor_id, a.device_id, 'transfer', p_item::text, d.message); end if;
    if d.decision = 'flag' then fl := d.message; end if;
  end if;
  r := 'TRF-' || upper(substr(replace(p_id::text, '-', ''), 1, 8));
  insert into movements (id, item_id, location_id, qty, kind, reason, note, ref, actor_id, device_id, session_user_id, flag, happened_at) values
    (p_id, p_item, p_from, -p_qty, 'transfer', 'To ' || lt.name, p_note, r, a.actor_id, a.device_id, auth.uid(), fl, p_at),
    (p_id_in, p_item, p_to, p_qty, 'transfer', 'From ' || lf.name, p_note, r, a.actor_id, a.device_id, auth.uid(), null, p_at);
  perform write_audit(a.actor_id, a.device_id, 'stock.transfer', 'movements', p_id::text,
    jsonb_build_object('ref', r, 'qty', p_qty, 'from', p_from, 'to', p_to));
  return (p_id, false, false, null, fl, stock_here(p_item, p_from), stock_total(p_item))::door_result;
end $$;

create or replace function record_count(p_id uuid, p_token text, p_at timestamptz, p_item uuid, p_location uuid,
  p_counted numeric, p_note text default null)
returns door_result language plpgsql security definer set search_path = public as $$
declare a record; have numeric; delta numeric;
begin
  if exists (select 1 from movements where id = p_id) then
    return (p_id, true, false, null, null, stock_here(p_item, p_location), stock_total(p_item))::door_result;
  end if;
  select * into a from resolve_actor(p_token, p_at);
  if a.problem is not null then return refused(a.actor_id, a.device_id, 'count', p_item::text, a.problem); end if;
  if not has_perm(a.actor_role, 'adjust') then return refused(a.actor_id, a.device_id, 'count', p_item::text, 'Only an Inventory Manager or Director records a shelf count.'); end if;
  if not can_see_location(p_location) then return refused(a.actor_id, a.device_id, 'count', p_item::text, 'Not a location you can count.'); end if;
  if p_counted is null or p_counted < 0 then return refused(a.actor_id, a.device_id, 'count', p_item::text, 'Enter what is on the shelf (0 or more).'); end if;
  have := lock_level(p_item, p_location);
  delta := p_counted - have;
  if delta = 0 then
    perform write_audit(a.actor_id, a.device_id, 'stock.count_match', 'items', p_item::text, jsonb_build_object('counted', p_counted));
    return (null::uuid, false, false, 'Count matches.', null::text, have, stock_total(p_item))::door_result;
  end if;
  insert into movements (id, item_id, location_id, qty, kind, reason, note, actor_id, device_id, session_user_id, happened_at)
  values (p_id, p_item, p_location, delta, 'count', 'Shelf count', p_note, a.actor_id, a.device_id, auth.uid(), p_at);
  perform write_audit(a.actor_id, a.device_id, 'stock.count', 'movements', p_id::text, jsonb_build_object('counted', p_counted, 'delta', delta));
  return (p_id, false, false, null, null, stock_here(p_item, p_location), stock_total(p_item))::door_result;
end $$;

-- Undo never erases: it records the opposite movement, linked to the original. A transfer is undone as a pair.
create or replace function undo_move(p_id uuid, p_token text, p_at timestamptz, p_target uuid)
returns door_result language plpgsql security definer set search_path = public as $$
declare a record; t movements; leg movements; first boolean := true;
begin
  if exists (select 1 from movements where id = p_id) then
    return (p_id, true, false, null, null, null, null)::door_result;
  end if;
  select * into a from resolve_actor(p_token, p_at);
  if a.problem is not null then return refused(a.actor_id, a.device_id, 'undo', p_target::text, a.problem); end if;
  if not has_perm(a.actor_role, 'issue') then return refused(a.actor_id, a.device_id, 'undo', p_target::text, 'This role can''t undo scans.'); end if;
  select * into t from movements where id = p_target;
  if not found or not can_see_location(t.location_id) then return refused(a.actor_id, a.device_id, 'undo', p_target::text, 'Movement not found.'); end if;
  if t.kind = 'undo' then return refused(a.actor_id, a.device_id, 'undo', p_target::text, 'An undo can''t be undone. Scan the item again instead.'); end if;
  if exists (select 1 from movements where reverses = p_target) then return refused(a.actor_id, a.device_id, 'undo', p_target::text, 'Already undone.'); end if;
  if not (a.actor_role in ('director', 'inventory') or (t.actor_id = a.actor_id and t.recorded_at > now() - interval '10 minutes')) then
    return refused(a.actor_id, a.device_id, 'undo', p_target::text, 'You can undo your own scans for 10 minutes. After that, ask an Inventory Manager.');
  end if;
  for leg in
    select * from movements m
    where (m.id = p_target or (t.kind = 'transfer' and m.kind = 'transfer' and m.ref = t.ref))
      and not exists (select 1 from movements u where u.reverses = m.id)
    order by (m.id = p_target) desc
  loop
    insert into movements (id, item_id, location_id, qty, kind, reason, ref, reverses, actor_id, device_id, session_user_id, happened_at)
    values (case when first then p_id else gen_random_uuid() end, leg.item_id, leg.location_id, -leg.qty, 'undo', 'Undo',
            leg.ref, leg.id, a.actor_id, a.device_id, auth.uid(), p_at);
    first := false;
  end loop;
  perform write_audit(a.actor_id, a.device_id, 'stock.undo', 'movements', p_id::text, jsonb_build_object('reverses', p_target));
  return (p_id, false, false, null, null, stock_here(t.item_id, t.location_id), stock_total(t.item_id))::door_result;
end $$;

-- ---------------------------------------------------------- tablet PINs --

create or replace function tablet_sign_in(p_staff uuid, p_pin text,
  out token text, out expires_at timestamptz, out display_name text, out role staff_role,
  out refused boolean, out locked boolean, out reason text)
language plpgsql security definer set search_path = public as $$
declare s staff; h text; fails int;
begin
  refused := true; locked := false;
  if not is_device() then reason := 'Only a kitchen tablet signs people in this way.'; return; end if;
  select * into s from staff where id = p_staff and active;
  if not found then reason := 'That person is not active.'; return; end if;
  select count(*) into fails from pin_attempts
    where staff_id = p_staff and not ok and at > now() - interval '15 minutes';
  if fails >= 5 then locked := true; reason := 'Too many wrong PINs. Wait 15 minutes or ask a Director.'; return; end if;
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

create or replace function tablet_sign_out(p_token text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  update actor_sessions set ended_at = now()
  where token_hash = encode(digest(p_token, 'sha256'), 'hex') and device_id = auth.uid() and ended_at is null;
  return found;
end $$;

-- ------------------------------------------------------ people (Director) --

-- The very first session on an empty database becomes the Director. Turn off open
-- sign-ups in Supabase Auth before going live, so nobody else can be first.
create or replace function bootstrap_first_director(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare e text; new_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in first.'; end if;
  if exists (select 1 from staff) then raise exception 'Setup is already done.'; end if;
  select email into e from auth.users where id = auth.uid();
  insert into staff (display_name, role, email, auth_user_id) values (coalesce(nullif(trim(p_name), ''), e), 'director', lower(e), auth.uid())
  returning id into new_id;
  perform write_audit(new_id, null, 'setup.first_director', 'staff', new_id::text, '{}');
  return new_id;
end $$;

-- A manager added by email links their sign-in the first time they use the code.
create or replace function claim_my_staff() returns boolean
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  select lower(email) into e from auth.users where id = auth.uid();
  update staff set auth_user_id = auth.uid()
  where lower(email) = e and auth_user_id is null and active and role in ('director', 'inventory');
  return found or is_manager();
end $$;

create or replace function save_staff(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare me staff; sid uuid := nullif(p->>'id', '')::uuid; r staff_role := (p->>'role')::staff_role;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director manages people.'; end if;
  if sid is null then
    insert into staff (display_name, role, email, created_by)
    values (trim(p->>'display_name'), r, lower(nullif(trim(p->>'email'), '')), me.id) returning id into sid;
    perform write_audit(me.id, null, 'staff.added', 'staff', sid::text, jsonb_build_object('role', r));
  else
    if sid = me.id and (r <> 'director' or not coalesce((p->>'active')::boolean, true)) then
      raise exception 'You can''t remove your own Director access. Another Director has to.';
    end if;
    update staff set display_name = trim(p->>'display_name'), role = r, email = lower(nullif(trim(p->>'email'), '')),
      active = coalesce((p->>'active')::boolean, true) where id = sid;
    perform write_audit(me.id, null, 'staff.updated', 'staff', sid::text, jsonb_build_object('role', r, 'active', p->>'active'));
  end if;
  return sid;
end $$;

create or replace function set_pin(p_staff uuid, p_pin text) returns boolean
language plpgsql security definer set search_path = public as $$
declare me staff;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director sets PINs.'; end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,8}$' then raise exception 'A PIN is 4 to 8 digits.'; end if;
  insert into staff_pins (staff_id, pin_hash, set_by) values (p_staff, crypt(p_pin, gen_salt('bf', 8)), me.id)
  on conflict (staff_id) do update set pin_hash = excluded.pin_hash, set_at = now(), set_by = excluded.set_by;
  perform write_audit(me.id, null, 'pin.set', 'staff', p_staff::text, '{}');
  return true;
end $$;

-- A tablet is an auth user made in Supabase Auth (email + password); this ties it to locations.
create or replace function register_device(p_email text, p_name text, p_locations uuid[]) returns uuid
language plpgsql security definer set search_path = public as $$
declare me staff; uid uuid; l uuid;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'people') then raise exception 'Only a Director adds tablets.'; end if;
  select id into uid from auth.users where lower(email) = lower(trim(p_email));
  if uid is null then raise exception 'No sign-in exists for %. Create it in Supabase Auth first.', p_email; end if;
  if exists (select 1 from staff where auth_user_id = uid) then raise exception 'That sign-in belongs to a person, not a tablet.'; end if;
  insert into devices (id, name, created_by) values (uid, trim(p_name), me.id)
  on conflict (id) do update set name = excluded.name, active = true;
  foreach l in array coalesce(p_locations, '{}') loop
    insert into device_locations (device_id, location_id) values (uid, l) on conflict do nothing;
  end loop;
  perform write_audit(me.id, null, 'device.registered', 'devices', uid::text, jsonb_build_object('name', p_name));
  return uid;
end $$;

-- ------------------------------------------------- catalogue (managers) --

create or replace function next_sku(p_category text) returns text
language sql stable security definer set search_path = public as $$
  select c.prefix || '-' || lpad((coalesce(max(nullif(regexp_replace(substr(i.sku, length(c.prefix) + 2), '\D', '', 'g'), '')::int), 0) + 1)::text, 4, '0')
  from categories c left join items i on i.sku like c.prefix || '-%'
  where c.name = p_category group by c.prefix
$$;

create or replace function save_item(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare me staff; iid uuid := nullif(p->>'id', '')::uuid; v_sku text; v_cat text := coalesce(nullif(p->>'category', ''), 'Other');
  v_open numeric := nullif(p->>'opening', '')::numeric; v_loc uuid := nullif(p->>'location_id', '')::uuid;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director edits items.'; end if;
  if not exists (select 1 from categories where name = v_cat and active) then raise exception 'Category % doesn''t exist.', v_cat; end if;
  if iid is not null then
    update items set name = trim(p->>'name'), category = v_cat, unit = trim(p->>'unit'),
      min_level = coalesce(nullif(p->>'min_level', '')::numeric, 0), par_level = coalesce(nullif(p->>'par_level', '')::numeric, 0),
      price = coalesce(nullif(p->>'price', '')::numeric, 0), supplier = nullif(trim(p->>'supplier'), ''),
      spot = nullif(trim(p->>'spot'), ''), active = coalesce((p->>'active')::boolean, true), updated_at = now()
    where id = iid;
    perform write_audit(me.id, null, 'item.updated', 'items', iid::text, jsonb_build_object('name', p->>'name'));
    return iid;
  end if;
  v_sku := upper(coalesce(nullif(trim(p->>'sku'), ''), next_sku(v_cat)));
  insert into items (sku, name, category, unit, min_level, par_level, price, supplier, spot, created_by)
  values (v_sku, trim(p->>'name'), v_cat, coalesce(nullif(trim(p->>'unit'), ''), 'units'),
    coalesce(nullif(p->>'min_level', '')::numeric, 0), coalesce(nullif(p->>'par_level', '')::numeric, 0),
    coalesce(nullif(p->>'price', '')::numeric, 0), nullif(trim(p->>'supplier'), ''), nullif(trim(p->>'spot'), ''), me.id)
  returning id into iid;
  if nullif(trim(p->>'barcode'), '') is not null then
    insert into item_codes (code, item_id, pack_qty, label, created_by) values (trim(p->>'barcode'), iid, 1, 'Maker barcode', me.id);
  end if;
  if v_open is not null and v_open > 0 then
    if v_loc is null then select id into v_loc from locations where active order by created_at limit 1; end if;
    insert into movements (id, item_id, location_id, qty, kind, reason, actor_id, session_user_id, happened_at)
    values (gen_random_uuid(), iid, v_loc, v_open, 'count', 'Opening count', me.id, auth.uid(), now());
  end if;
  perform write_audit(me.id, null, 'item.created', 'items', iid::text, jsonb_build_object('sku', v_sku));
  return iid;
end $$;

create or replace function add_code(p_item uuid, p_code text, p_pack numeric default 1, p_label text default null) returns boolean
language plpgsql security definer set search_path = public as $$
declare me staff; other text;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director adds barcodes.'; end if;
  if p_code ~* '^HK1:' then raise exception 'That is one of our own labels. Scan the maker''s barcode instead.'; end if;
  select i.name into other from item_codes c join items i on i.id = c.item_id where c.code = trim(p_code);
  if other is not null then raise exception 'That barcode already belongs to %.', other; end if;
  if exists (select 1 from items where sku = upper(trim(p_code))) then raise exception 'That code is already a SKU.'; end if;
  insert into item_codes (code, item_id, pack_qty, label, created_by) values (trim(p_code), p_item, coalesce(p_pack, 1), p_label, me.id);
  perform write_audit(me.id, null, 'code.added', 'item_codes', trim(p_code), jsonb_build_object('item', p_item, 'pack', p_pack));
  return true;
end $$;

create or replace function set_code_active(p_code text, p_active boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare me staff;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director retires barcodes.'; end if;
  update item_codes set active = p_active where code = p_code;
  perform write_audit(me.id, null, case when p_active then 'code.restored' else 'code.retired' end, 'item_codes', p_code, '{}');
  return found;
end $$;

create or replace function save_location(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare me staff; lid uuid := nullif(p->>'id', '')::uuid; act boolean := coalesce((p->>'active')::boolean, true);
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'items_edit') then raise exception 'Only an Inventory Manager or Director edits locations.'; end if;
  if lid is null then
    insert into locations (name, kind) values (trim(p->>'name'), coalesce(nullif(p->>'kind', ''), 'storage')::location_kind) returning id into lid;
  else
    if not act and exists (select 1 from stock_levels where location_id = lid and on_hand <> 0) then
      raise exception 'Stock is still recorded there. Move or count it to zero before closing.';
    end if;
    update locations set name = trim(p->>'name'), kind = coalesce(nullif(p->>'kind', ''), 'storage')::location_kind, active = act where id = lid;
  end if;
  perform write_audit(me.id, null, 'location.saved', 'locations', lid::text, p);
  return lid;
end $$;

-- Every door: not for anon (FQC 0029/0030), for signed-in sessions only. Internal helpers: for nobody.
revoke all on function stock_here(uuid, uuid), stock_total(uuid), write_audit(uuid, uuid, text, text, text, jsonb),
  resolve_actor(text, timestamptz), refused(uuid, uuid, text, text, text), lock_level(uuid, uuid)
  from public, anon, authenticated;
revoke all on function shortfall_decision(numeric, numeric, staff_role, text) from public, anon, authenticated;
revoke all on function
  record_move(uuid, text, timestamptz, uuid, uuid, text, numeric, text, text, text),
  record_transfer(uuid, uuid, text, timestamptz, uuid, uuid, uuid, numeric, text),
  record_count(uuid, text, timestamptz, uuid, uuid, numeric, text),
  undo_move(uuid, text, timestamptz, uuid),
  tablet_sign_in(uuid, text), tablet_sign_out(text),
  bootstrap_first_director(text), claim_my_staff(), save_staff(jsonb), set_pin(uuid, text),
  register_device(text, text, uuid[]), next_sku(text), save_item(jsonb), add_code(uuid, text, numeric, text),
  set_code_active(text, boolean), save_location(jsonb)
  from public, anon;
grant execute on function
  record_move(uuid, text, timestamptz, uuid, uuid, text, numeric, text, text, text),
  record_transfer(uuid, uuid, text, timestamptz, uuid, uuid, uuid, numeric, text),
  record_count(uuid, text, timestamptz, uuid, uuid, numeric, text),
  undo_move(uuid, text, timestamptz, uuid),
  tablet_sign_in(uuid, text), tablet_sign_out(text),
  bootstrap_first_director(text), claim_my_staff(), save_staff(jsonb), set_pin(uuid, text),
  register_device(text, text, uuid[]), next_sku(text), save_item(jsonb), add_code(uuid, text, numeric, text),
  set_code_active(text, boolean), save_location(jsonb)
  to authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 5 $$;

select 'part 0005 applied' as proof,
  has_function_privilege('anon', 'record_move(uuid,text,timestamptz,uuid,uuid,text,numeric,text,text,text)', 'execute') as anon_can_move,
  has_function_privilege('authenticated', 'resolve_actor(text,timestamptz)', 'execute') as session_can_resolve,
  hk_schema_version() as version;
