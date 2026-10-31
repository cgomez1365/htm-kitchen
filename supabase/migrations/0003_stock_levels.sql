-- ===========================================================================
-- Hope Kitchen web — 0003: stock is the ledger
-- ===========================================================================
-- On hand is never typed. stock_levels is a running total the trigger below keeps
-- on every movement; verify_stock() recomputes it from the ledger and lists any
-- place they disagree (the Mac app measured 0 mismatches over 400k rows).
-- stock_levels refuses UPDATE unless the trigger itself is the writer.
-- ===========================================================================

create or replace function movements_keep_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform set_config('hk.stock_writer', 'on', true);
  insert into stock_levels (item_id, location_id, on_hand, last_at)
  values (new.item_id, new.location_id, new.qty, new.happened_at)
  on conflict (item_id, location_id) do update
    set on_hand = stock_levels.on_hand + excluded.on_hand,
        last_at = greatest(coalesce(stock_levels.last_at, excluded.last_at), excluded.last_at);
  perform set_config('hk.stock_writer', 'off', true);
  return new;
end $$;

create trigger movements_keep_stock after insert on movements
  for each row execute function movements_keep_stock();

create or replace function stock_levels_guard() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('hk.stock_writer', true), 'off') <> 'on' then
    raise exception 'Stock comes only from movements.' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger stock_levels_no_update before update on stock_levels
  for each row execute function stock_levels_guard();

-- Totals per item; security_invoker so it shows only what the caller may see (FQC trap: views leak otherwise).
create view stock with (security_invoker = true) as
  select i.*,
    coalesce((select sum(s.on_hand) from stock_levels s where s.item_id = i.id), 0) as on_hand,
    (select max(s.last_at) from stock_levels s where s.item_id = i.id) as last_moved,
    (select string_agg(c.code, ' ') from item_codes c where c.item_id = i.id and c.active) as codes
  from items i;

create or replace function verify_stock()
returns table (sku text, name text, location text, ledger numeric, cached numeric)
language sql stable security definer set search_path = public as $$
  with truth as (select item_id, location_id, sum(qty) as q from movements group by 1, 2)
  select i.sku, i.name, l.name, t.q, coalesce(s.on_hand, 0)
  from truth t join items i on i.id = t.item_id join locations l on l.id = t.location_id
  left join stock_levels s on s.item_id = t.item_id and s.location_id = t.location_id
  where t.q <> coalesce(s.on_hand, 0)
$$;

revoke all on function movements_keep_stock() from public, anon, authenticated;
revoke all on function stock_levels_guard() from public, anon, authenticated;
revoke all on function verify_stock() from public, anon, authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 3 $$;

select 'part 0003 applied' as proof, hk_schema_version() as version;
