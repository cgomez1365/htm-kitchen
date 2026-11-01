-- ===========================================================================
-- Hope Kitchen web — 0008: let the doors see pgcrypto on Supabase
-- ===========================================================================
-- Found 2026-10-31 while preparing go-live. Supabase installs pgcrypto in schema
-- "extensions", not "public". Every door here was written `set search_path = public`,
-- so on a real Supabase project crypt(), gen_salt(), digest() and gen_random_bytes()
-- do not exist for them: the first PIN a Director set would have failed with
-- "function gen_salt(unknown, integer) does not exist". The tests never saw it
-- because their Postgres had pgcrypto in public; tools/pg-stubs.js now puts it in
-- "extensions" the way Supabase does, and the suite failed exactly there before this.
--
-- FQC writes `set search_path = public, extensions` (0028, 0033, 0036). This does the
-- same for every function in public that pins its search_path to public alone.
-- A schema missing from search_path is skipped by Postgres, so this is harmless where
-- pgcrypto does live in public. NEW FUNCTIONS: write `set search_path = public, extensions`
-- (tools/test-sql.mjs fails on any that pin public alone).
-- ===========================================================================

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proconfig @> array['search_path=public']
  loop
    execute format('alter function %s set search_path = public, extensions', f.sig);
  end loop;
end $$;

create or replace function hk_schema_version() returns int language sql immutable as $$ select 8 $$;

select 'part 0008 applied' as proof,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proconfig @> array['search_path=public']) as still_public_only,
  hk_schema_version() as version;
