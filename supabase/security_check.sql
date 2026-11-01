-- ===========================================================================
-- Hope Kitchen web — security self-check (read-only; safe to run any time)
-- ===========================================================================
-- Paste into the SQL Editor of the Hope Kitchen project, or let master.sql run it last.
-- It changes nothing. It fails with a list of every rule that is broken, or ends with
-- "security check passed". tools/test-sql.mjs runs it, and proves it fails when a rule breaks.
--
-- What it checks, and why (FQC's lessons, 2026-09):
--   1. Row Level Security is on for every table           (a table without it is readable by anyone signed in)
--   2. No policy lets anyone insert, update or delete       (every write goes through a door)
--   3. Signed-out visitors can run nothing but the version  (Supabase grants new functions to anon by name)
--   4. Signed-in sessions cannot run the internal helpers   (audit writer, actor resolver, pairing redeemer...)
--   5. Only the server's service role redeems pairing codes
--   6. Nobody signed in can insert, update or delete a table directly
--   7. PIN hashes, PIN tries, sessions, unlocks and pairing codes are unreadable to sessions
--   8. Every privileged function fixes its search_path, never public alone (pgcrypto, 0008)
--   9. Every table refuses deletion (records never disappear, 0002)
--  10. Every view reads as the caller (security_invoker), so it cannot widen what RLS allows
-- Not checkable from SQL (do them in the dashboard; docs/GO_LIVE.md): sign-ups off, 6-digit codes,
-- the service key only in Vercel's server variables, MFA on the dashboard accounts.
-- ===========================================================================

do $check$
declare
  bad text[] := '{}';
  r record;
  internal text[] := array['refuse_record_deletion','refuse_record_edit','stock_levels_guard','movements_keep_stock',
    'stock_here','stock_total','shortfall_decision','write_audit','resolve_actor','refused','lock_level',
    'pin_fail_count','redeem_pairing','verify_stock'];
  secret text[] := array['staff_pins','pin_attempts','actor_sessions','pin_unlocks','device_pairings'];
begin
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity loop
    bad := bad || format('1. RLS is off on table %s', r.relname);
  end loop;
  for r in select tablename, policyname, cmd from pg_policies where schemaname = 'public' and cmd <> 'SELECT' loop
    bad := bad || format('2. policy %s on %s allows %s', r.policyname, r.tablename, r.cmd);
  end loop;
  for r in select p.oid::regprocedure::text as f from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname <> 'hk_schema_version'
             and has_function_privilege('anon', p.oid, 'execute') loop
    bad := bad || format('3. signed-out visitors can run %s', r.f);
  end loop;
  for r in select p.oid::regprocedure::text as f from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.proname = any(internal)
             and has_function_privilege('authenticated', p.oid, 'execute') loop
    bad := bad || format('4. signed-in sessions can run internal %s', r.f);
  end loop;
  if to_regprocedure('public.redeem_pairing(text)') is null
     or not has_function_privilege('service_role', 'public.redeem_pairing(text)', 'execute') then
    bad := bad || '5. the service role cannot redeem pairing codes'::text;
  end if;
  for r in select c.relname, x.role, p.priv from pg_class c
           cross join (values ('anon'), ('authenticated')) x(role)
           cross join unnest(array['INSERT','UPDATE','DELETE','TRUNCATE']) p(priv)
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and has_table_privilege(x.role, c.oid, p.priv) loop
    bad := bad || format('6. %s can %s table %s directly', r.role, r.priv, r.relname);
  end loop;
  for r in select t, x.role from unnest(secret) t cross join (values ('anon'), ('authenticated')) x(role)
           where to_regclass('public.' || t) is not null and has_table_privilege(x.role, ('public.' || t)::regclass, 'SELECT') loop
    bad := bad || format('7. %s can read %s', r.role, r.t);
  end loop;
  for r in select p.oid::regprocedure::text as f, coalesce(array_to_string(p.proconfig, ','), 'none') as cfg from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prosecdef
             and (p.proconfig is null or p.proconfig @> array['search_path=public']
                  or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')) loop
    bad := bad || format('8. privileged %s has search_path %s', r.f, r.cfg);
  end loop;
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and not exists (select 1 from pg_trigger g join pg_proc p on p.oid = g.tgfoid
                             where g.tgrelid = c.oid and p.proname = 'refuse_record_deletion') loop
    bad := bad || format('9. table %s can be deleted from', r.relname);
  end loop;
  for r in select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'v'
             and not coalesce(c.reloptions @> array['security_invoker=true'], false) loop
    bad := bad || format('10. view %s does not read as the caller', r.relname);
  end loop;
  if array_length(bad, 1) > 0 then
    raise exception E'Hope Kitchen security check FAILED (% problems):\n%', array_length(bad, 1), array_to_string(bad, E'\n');
  end if;
  raise notice 'Hope Kitchen security check passed';
end $check$;

select 'security check passed' as security_check;
