-- ===========================================================================
-- Hope Kitchen web — 0006: what the screens read
-- ===========================================================================
-- Searching and adding up happen in the database, one page at a time: PostgREST
-- answers at most 1,000 rows and a Vercel function at most 4.5 MB (FQC traps), and
-- a catalogue of 20,000 SKUs must never be sent whole.
--
-- The catalogue reads are SECURITY INVOKER, so Row Level Security decides what each
-- caller sees. The two reads that print people's names (feed, pull records) are
-- DEFINER, because a tablet may not read the staff table (FQC trap: names under
-- RLS come back null); they filter by can_see_location() themselves.
-- Every "today" is Los Angeles time, never UTC (FQC trap).
-- ===========================================================================

create or replace function facility_today() returns date
language sql stable as $$ select (now() at time zone 'America/Los_Angeles')::date $$;

create or replace function facility_midnight(d date) returns timestamptz
language sql stable as $$ select (d::timestamp) at time zone 'America/Los_Angeles' $$;

-- Our label (HK1:SKU), a bare SKU, or a maker barcode, which may be a case of N.
create or replace function lookup_code(p_code text, p_location uuid default null) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare c text := trim(coalesce(p_code, '')); it record; cd item_codes;
begin
  if upper(c) like 'HK1:%' then c := substr(c, 5); end if;
  select s.*, (select on_hand from stock_levels l where l.item_id = s.id and l.location_id = p_location) as here
    into it from stock s where s.sku = upper(c);
  if found then return jsonb_build_object('found', true, 'item', to_jsonb(it), 'packQty', 1, 'via', 'sku'); end if;
  select * into cd from item_codes where code = c;
  if not found then return jsonb_build_object('found', false, 'code', c); end if;
  if not cd.active then return jsonb_build_object('found', false, 'code', c, 'retired', true); end if;
  select s.*, (select on_hand from stock_levels l where l.item_id = s.id and l.location_id = p_location) as here
    into it from stock s where s.id = cd.item_id;
  return jsonb_build_object('found', true, 'item', to_jsonb(it), 'packQty', cd.pack_qty, 'packLabel', cd.label, 'via', 'code');
end $$;

-- p: q, category, state (active|attention|low|out|inactive|all), location_id, only_here, sort, dir, limit, offset
create or replace function item_search(p jsonb) returns jsonb
language plpgsql stable security invoker set search_path = public as $$
declare
  q text := nullif(trim(p->>'q'), '');
  st text := coalesce(p->>'state', 'active');
  loc uuid := nullif(p->>'location_id', '')::uuid;
  lim int := least(greatest(coalesce((p->>'limit')::int, 50), 1), 200);
  off int := greatest(coalesce((p->>'offset')::int, 0), 0);
  srt text := coalesce(p->>'sort', 'category');
  desc_ boolean := coalesce(p->>'dir', 'asc') = 'desc';
  words text[] := coalesce(regexp_split_to_array(q, '\s+'), '{}');
  total int; rows jsonb;
begin
  with base as (
    select s.*, coalesce((select on_hand from stock_levels l where l.item_id = s.id and l.location_id = loc), 0) as here
    from stock s
    where (case st
        when 'inactive' then not s.active
        when 'all' then true
        when 'low' then s.active and s.min_level > 0 and s.on_hand <= s.min_level and s.on_hand > 0
        when 'out' then s.active and s.on_hand <= 0
        when 'attention' then s.active and (s.on_hand <= 0 or (s.min_level > 0 and s.on_hand <= s.min_level))
        else s.active end)
      and (p->>'category' is null or p->>'category' = '' or s.category = p->>'category')
      and (not coalesce((p->>'only_here')::boolean, false)
           or exists (select 1 from stock_levels l where l.item_id = s.id and l.location_id = loc and l.on_hand <> 0))
      and (select bool_and(s.name ilike '%' || w || '%' or s.sku ilike '%' || w || '%'
                           or coalesce(s.codes, '') ilike '%' || w || '%' or coalesce(s.supplier, '') ilike '%' || w || '%')
           from unnest(words) w) is not false
  ),
  page as (
    select * from base
    order by
      case when not desc_ then case srt when 'name' then lower(name) when 'sku' then sku when 'category' then category || ' ' || lower(name) end end asc,
      case when desc_ then case srt when 'name' then lower(name) when 'sku' then sku when 'category' then category || ' ' || lower(name) end end desc,
      case when not desc_ then case srt when 'on_hand' then on_hand when 'here' then here when 'value' then greatest(on_hand, 0) * price when 'min_level' then min_level end end asc,
      case when desc_ then case srt when 'on_hand' then on_hand when 'here' then here when 'value' then greatest(on_hand, 0) * price when 'min_level' then min_level end end desc,
      case when not desc_ and srt = 'last_moved' then last_moved end asc nulls first,
      case when desc_ and srt = 'last_moved' then last_moved end desc nulls last,
      lower(name), id
    limit lim offset off
  )
  select (select count(*) from base), coalesce((select jsonb_agg(to_jsonb(page)) from page), '[]') into total, rows;
  return jsonb_build_object('rows', rows, 'total', total, 'offset', off, 'limit', lim);
end $$;

create or replace function item_detail(p_item uuid) returns jsonb
language sql stable security invoker set search_path = public as $$
  select to_jsonb(s) || jsonb_build_object(
    'levels', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'kind', l.kind,
                 'on_hand', coalesce(sl.on_hand, 0), 'last_at', sl.last_at) order by l.created_at)
               from locations l left join stock_levels sl on sl.location_id = l.id and sl.item_id = s.id
               where l.active), '[]'),
    'code_list', coalesce((select jsonb_agg(to_jsonb(c) order by c.active desc, c.pack_qty) from item_codes c where c.item_id = s.id), '[]'),
    'pulled_30', coalesce((select -sum(m.qty) from movements m left join movements o on o.id = m.reverses
               where m.item_id = s.id and m.happened_at >= now() - interval '30 days'
                 and (case when m.kind = 'undo' then o.kind else m.kind end) = 'issue'), 0))
  from stock s where s.id = p_item
$$;

-- Recent movements with the person's name, for the scan screen and the item drawer.
create or replace function movement_feed(p_location uuid default null, p_item uuid default null, p_limit int default 30)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.happened_at desc), '[]') from (
    select m.id, m.kind, m.qty, m.reason, m.ref, m.flag, m.happened_at, m.reverses, i.sku, i.name as item_name, i.unit,
      st.display_name as person_name, l.name as location_name,
      exists (select 1 from movements u where u.reverses = m.id) as undone
    from movements m join items i on i.id = m.item_id join staff st on st.id = m.actor_id join locations l on l.id = m.location_id
    where can_see_location(m.location_id)
      and (p_location is null or m.location_id = p_location) and (p_item is null or m.item_id = p_item)
    order by m.happened_at desc limit least(greatest(coalesce(p_limit, 30), 1), 200)
  ) x
$$;

create or replace function dashboard(p_location uuid default null) returns jsonb
language sql stable security invoker set search_path = public as $$
  with today as (select facility_midnight(facility_today()) as since)
  select jsonb_build_object(
    'items', (select count(*) from items where active),
    'attention', (select count(*) from stock where active and (on_hand <= 0 or (min_level > 0 and on_hand <= min_level))),
    'value', (select coalesce(sum(greatest(on_hand, 0) * price), 0) from stock where active),
    'moves_today', (select count(*) from movements, today where happened_at >= today.since),
    'pulls_today', (select count(*) from movements m, today where m.kind = 'issue' and m.happened_at >= today.since
                    and not exists (select 1 from movements u where u.reverses = m.id)),
    'pull_cost_today', (select coalesce(sum(-m.qty * i.price), 0) from movements m join items i on i.id = m.item_id, today
                    where m.kind = 'issue' and m.happened_at >= today.since and not exists (select 1 from movements u where u.reverses = m.id)),
    'flagged_today', (select count(*) from movements, today where flag is not null and happened_at >= today.since),
    'low', coalesce((select jsonb_agg(to_jsonb(x)) from (
              select id, sku, name, unit, on_hand, min_level, par_level from stock
              where active and min_level > 0 and on_hand <= min_level order by on_hand / nullif(min_level, 0), name limit 12) x), '[]'))
$$;

-- Pull records: one page of rows plus totals over the whole range, added up in the database.
create or replace function report_pulls(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  me staff; f timestamptz := nullif(p->>'from', '')::timestamptz; t timestamptz := nullif(p->>'to', '')::timestamptz;
  loc uuid := nullif(p->>'location_id', '')::uuid; who uuid := nullif(p->>'person_id', '')::uuid;
  lim int := least(greatest(coalesce((p->>'limit')::int, 100), 1), 1000); off int := greatest(coalesce((p->>'offset')::int, 0), 0);
  res jsonb;
begin
  select * into me from me_staff();
  if me.id is null or not has_perm(me.role, 'reports') then raise exception 'Reports are for Inventory Managers and Directors.'; end if;
  with pulls as (
    select m.id, m.happened_at, i.sku, i.name, i.category, -m.qty as qty, i.unit, round(-m.qty * i.price, 2) as cost,
      m.reason, m.ref, st.display_name as person, l.name as location, m.flag
    from movements m join items i on i.id = m.item_id join staff st on st.id = m.actor_id join locations l on l.id = m.location_id
    where m.kind = 'issue' and not exists (select 1 from movements u where u.reverses = m.id)
      and (f is null or m.happened_at >= f) and (t is null or m.happened_at < t)
      and (loc is null or m.location_id = loc) and (who is null or m.actor_id = who)
      and (p->>'category' is null or p->>'category' = '' or i.category = p->>'category')
      and (p->>'reason' is null or p->>'reason' = '' or m.reason = p->>'reason')
  )
  select jsonb_build_object(
    'total', (select count(*) from pulls),
    'totals', jsonb_build_object('pulls', (select count(*) from pulls), 'cost', (select coalesce(sum(cost), 0) from pulls),
                                 'items', (select count(distinct sku) from pulls), 'people', (select count(distinct person) from pulls)),
    'by_person', coalesce((select jsonb_agg(x) from (select person as label, sum(cost) as value from pulls group by person order by 2 desc limit 10) x), '[]'),
    'rows', coalesce((select jsonb_agg(x) from (select * from pulls order by happened_at desc, id limit lim offset off) x), '[]'))
  into res;
  return res;
end $$;

-- Who this session is, in one call: the manager, or the tablet and its locations. Nothing for strangers.
create or replace function whoami() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'manager', (select jsonb_build_object('id', s.id, 'display_name', s.display_name, 'role', s.role, 'email', s.email)
                from staff s where s.auth_user_id = auth.uid() and s.active and s.role in ('director', 'inventory')),
    'device', (select jsonb_build_object('id', d.id, 'name', d.name) from devices d where d.id = auth.uid() and d.active),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'kind', l.kind) order by l.created_at)
                 from locations l where l.active and can_see_location(l.id)), '[]'),
    'setup_needed', not exists (select 1 from staff))
$$;

revoke all on function facility_today(), facility_midnight(date) from public, anon;
grant execute on function facility_today(), facility_midnight(date) to authenticated;
revoke all on function lookup_code(text, uuid), item_search(jsonb), item_detail(uuid), movement_feed(uuid, uuid, int),
  dashboard(uuid), report_pulls(jsonb), whoami() from public, anon;
grant execute on function lookup_code(text, uuid), item_search(jsonb), item_detail(uuid), movement_feed(uuid, uuid, int),
  dashboard(uuid), report_pulls(jsonb), whoami() to authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 6 $$;

select 'part 0006 applied' as proof,
  has_function_privilege('anon', 'item_search(jsonb)', 'execute') as anon_can_search,
  hk_schema_version() as version;
