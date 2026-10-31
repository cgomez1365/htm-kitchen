-- ===========================================================================
-- Hope Kitchen web — 0002: records never disappear (FQC R-13, CEO 2026-09-27)
-- ===========================================================================
-- No role deletes or truncates a record, the owner included. The ledger and the
-- audit trail are never edited either: a mistake is a new row (an undo, a count).
-- The only way past is session_replication_role = replica, which is what a restore uses.
-- ===========================================================================

create or replace function refuse_record_deletion() returns trigger
language plpgsql as $$
begin
  raise exception 'Records are never deleted. Deactivate, retire or cancel instead. (%)', tg_table_name
    using errcode = 'P0001';
end $$;

create or replace function refuse_record_edit() returns trigger
language plpgsql as $$
begin
  raise exception 'This record is permanent. Record a correction instead. (%)', tg_table_name
    using errcode = 'P0001';
end $$;

do $$
declare t text;
begin
  foreach t in array array['locations','categories','staff','staff_pins','pin_attempts','devices','device_locations',
    'actor_sessions','items','item_codes','movements','stock_levels','requests','request_lines','losses','counts',
    'count_lines','audit_log']
  loop
    execute format('create trigger %I before delete on %I for each row execute function refuse_record_deletion()', t || '_no_delete', t);
    execute format('create trigger %I before truncate on %I for each statement execute function refuse_record_deletion()', t || '_no_truncate', t);
  end loop;
  foreach t in array array['movements','audit_log','pin_attempts']
  loop
    execute format('create trigger %I before update on %I for each row execute function refuse_record_edit()', t || '_no_update', t);
  end loop;
end $$;

revoke all on function refuse_record_deletion() from public, anon, authenticated;
revoke all on function refuse_record_edit() from public, anon, authenticated;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 2 $$;

select 'part 0002 applied' as proof,
  (select count(*) from pg_trigger where tgname like '%\_no\_delete') as delete_guards,
  hk_schema_version() as version;
