-- ===========================================================================
-- Hope Kitchen web — 0009: what people type is clean, in the database itself
-- ===========================================================================
-- CEO 2026-10-31: "include sanitation". The doors already trim and check names; this is
-- the backstop under every door, so no path (a door, a future one, a bad import) can store:
--   * control characters (the invisible bytes 0x01-0x1F and 0x7F-0x9F). One-line fields
--     refuse all of them; notes allow line breaks and tabs only;
--   * bidirectional overrides (U+202A-U+202E, U+2066-U+2069) and zero-width spaces
--     (U+200B, U+FEFF): they can make one name DISPLAY as another on the tablet roster
--     or in a report ("Trojan Source", CVE-2021-42574);
--   * text longer than the screens show.
-- Screens draw every value as text (React escapes it), so markup is harmless there. A CSV
-- export, when one is built, must still neutralise cells starting with = + - @ (formula
-- injection): that is an export rule, not a storage one.
-- ===========================================================================

-- One line: no control characters at all, no invisible direction or zero-width marks.
create or replace function hk_clean_line(t text, max_len int) returns boolean
language sql immutable set search_path = public, extensions as $$
  select t is null or (length(t) <= max_len
    and t !~ '[\x01-\x1F\x7F-\x9F]'
    and t !~ '[​‪-‮⁦-⁩﻿]')
$$;

-- A note: the same, except line breaks and tabs are allowed.
create or replace function hk_clean_note(t text, max_len int) returns boolean
language sql immutable set search_path = public, extensions as $$
  select t is null or (length(t) <= max_len
    and t !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]'
    and t !~ '[​‪-‮⁦-⁩﻿]')
$$;

alter table staff      add constraint staff_name_clean      check (hk_clean_line(display_name, 80));
alter table staff      add constraint staff_email_clean     check (email is null or (hk_clean_line(email, 254) and email = lower(email) and email ~ '^[^@\s]+@[^@\s]+$'));
alter table devices    add constraint devices_name_clean    check (hk_clean_line(name, 80) and length(trim(name)) >= 1);
alter table locations  add constraint locations_name_clean  check (hk_clean_line(name, 80));
alter table categories add constraint categories_name_clean check (hk_clean_line(name, 60));
alter table items      add constraint items_text_clean      check (hk_clean_line(name, 120) and hk_clean_line(unit, 20)
                                                               and hk_clean_line(spot, 60) and hk_clean_line(supplier, 120));
alter table item_codes add constraint item_codes_clean      check (code ~ '^[\x21-\x7E]{3,64}$' and hk_clean_line(label, 80));
alter table movements  add constraint movements_text_clean  check (hk_clean_line(reason, 120) and hk_clean_line(ref, 40) and hk_clean_note(note, 500));
alter table counts     add constraint counts_note_clean     check (hk_clean_note(note, 500));
alter table losses     add constraint losses_notes_clean    check (hk_clean_note(note, 500) and hk_clean_note(decided_note, 500));
alter table requests   add constraint requests_notes_clean  check (hk_clean_note(note, 500) and hk_clean_note(decided_note, 500));

revoke all on function hk_clean_line(text, int), hk_clean_note(text, int) from public, anon;
grant execute on function hk_clean_line(text, int), hk_clean_note(text, int) to authenticated;

create or replace function hk_schema_version() returns int language sql immutable set search_path = public, extensions as $$ select 9 $$;

select 'part 0009 applied' as proof,
  (select count(*) from pg_constraint where conname like '%\_clean' and connamespace = 'public'::regnamespace) as clean_checks,
  hk_schema_version() as version;
