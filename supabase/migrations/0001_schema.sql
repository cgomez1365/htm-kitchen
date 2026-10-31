-- ===========================================================================
-- Hope Kitchen web — 0001: the tables
-- ===========================================================================
-- Forward-only. Ported 2026-10-29 from the Mac app schema v2 (Sources/Schema.swift)
-- with the FQC rules applied: uuid ids, timestamptz, numeric quantities (a REAL
-- total drifts: 0.1 + 0.2), and no write policy anywhere - every write goes
-- through a SECURITY DEFINER door in 0005 (FQC R-05: if a rule matters, it is in SQL).
--
-- Who is who:
--   staff           everyone whose name goes on a record. Managers (director,
--                   inventory) also have an auth user and sign in with an emailed
--                   code; chefs, staff and drivers never hold an account.
--   devices         a kitchen tablet: one auth user (email + password), signed in
--                   once, tied to the locations it may move stock at.
--   actor_sessions  a person unlocked on a tablet with their own PIN. A scan names
--                   the session, so every pull is provably that person.
-- ===========================================================================

create extension if not exists pgcrypto;

create type staff_role as enum ('director', 'inventory', 'chef', 'staff', 'driver');
create type location_kind as enum ('kitchen', 'storage', 'site', 'vehicle');
create type movement_kind as enum ('receive', 'issue', 'return', 'loss', 'adjust', 'count', 'undo', 'transfer');

create table locations (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(trim(name)) between 1 and 80),
  kind location_kind not null default 'storage',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table categories (
  name text primary key check (length(trim(name)) between 1 and 60),
  prefix text not null unique check (prefix ~ '^[A-Z]{2,5}$'),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table staff (
  id uuid primary key default gen_random_uuid(),
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  role staff_role not null,
  email text unique,
  auth_user_id uuid unique references auth.users (id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references staff (id),
  -- a manager signs in by email; a tablet person never does
  check (role not in ('director', 'inventory') or email is not null)
);

-- Hash only. No policies: reached only through set_pin() and tablet_sign_in().
create table staff_pins (
  staff_id uuid primary key references staff (id),
  pin_hash text not null,
  set_at timestamptz not null default now(),
  set_by uuid references staff (id)
);

-- Wrong and right PIN tries. No policies: only tablet_sign_in() writes it, so a
-- session cannot forge rows to lock somebody out (FQC 0033).
create table pin_attempts (
  id bigserial primary key,
  staff_id uuid not null references staff (id),
  device_id uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index pin_attempts_recent on pin_attempts (staff_id, at);

create table devices (
  id uuid primary key references auth.users (id),
  name text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references staff (id)
);

create table device_locations (
  device_id uuid not null references devices (id),
  location_id uuid not null references locations (id),
  primary key (device_id, location_id)
);

create table actor_sessions (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  staff_id uuid not null references staff (id),
  device_id uuid not null references devices (id),
  started_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz
);

create table items (
  id uuid primary key default gen_random_uuid(),
  sku text not null unique check (sku ~ '^[A-Z0-9][A-Z0-9-]{1,31}$'),
  name text not null check (length(trim(name)) between 1 and 120),
  category text not null references categories (name),
  unit text not null check (length(trim(unit)) between 1 and 20),
  min_level numeric(12,3) not null default 0 check (min_level >= 0),
  par_level numeric(12,3) not null default 0 check (par_level >= 0),
  price numeric(12,2) not null default 0 check (price >= 0),
  supplier text,
  spot text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references staff (id),
  updated_at timestamptz
);
create index items_category_name on items (category, name);
create index items_name on items (lower(name));

-- Every barcode that scans as an item: a maker's UPC/EAN, or a case that counts as pack_qty.
-- Our own shelf label (HK1:<SKU>) is not stored; it is the SKU.
create table item_codes (
  code text primary key check (length(code) between 3 and 64 and code !~* '^HK1:'),
  item_id uuid not null references items (id),
  pack_qty numeric(12,3) not null default 1 check (pack_qty > 0),
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references staff (id)
);
create index item_codes_item on item_codes (item_id);

-- The ledger. The id is made ON THE DEVICE, so a scan queued offline and sent twice
-- is one row (the door answers the second send as a duplicate).
create table movements (
  id uuid primary key,
  item_id uuid not null references items (id),
  location_id uuid not null references locations (id),
  qty numeric(12,3) not null check (qty <> 0),
  kind movement_kind not null,
  reason text,
  note text check (note is null or length(note) <= 500),
  ref text,
  reverses uuid unique references movements (id),
  actor_id uuid not null references staff (id),
  device_id uuid references devices (id),
  session_user_id uuid not null,
  flag text,
  happened_at timestamptz not null,
  recorded_at timestamptz not null default now()
);
create index movements_item_time on movements (item_id, happened_at);
create index movements_time on movements (happened_at);
create index movements_kind_time on movements (kind, happened_at);
create index movements_actor_time on movements (actor_id, happened_at);
create index movements_location_item on movements (location_id, item_id);
create index movements_ref on movements (ref) where ref is not null;

-- Kept by the trigger in 0003, never by hand.
create table stock_levels (
  item_id uuid not null references items (id),
  location_id uuid not null references locations (id),
  on_hand numeric(14,3) not null default 0,
  last_at timestamptz,
  primary key (item_id, location_id)
);

create table requests (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  requested_by uuid not null references staff (id),
  status text not null check (status in ('pending','partial','fulfilled','received','denied','cancelled')),
  note text,
  decided_by uuid references staff (id),
  decided_note text,
  location_id uuid references locations (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table request_lines (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests (id),
  item_id uuid not null references items (id),
  qty_requested numeric(12,3) not null check (qty_requested > 0),
  qty_fulfilled numeric(12,3) not null default 0
);

create table losses (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references items (id),
  location_id uuid not null references locations (id),
  qty numeric(12,3) not null check (qty > 0),
  reason text not null check (reason in ('spoiled','damaged','broken','expired','other')),
  note text,
  reported_by uuid not null references staff (id),
  status text not null check (status in ('pending','approved','denied')),
  decided_by uuid references staff (id),
  decided_note text,
  decided_at timestamptz,
  movement_id uuid references movements (id),
  created_at timestamptz not null default now()
);

create table counts (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  location_id uuid not null references locations (id),
  category text references categories (name),
  status text not null check (status in ('open','submitted','cancelled')),
  note text,
  started_by uuid not null references staff (id),
  started_at timestamptz not null default now(),
  submitted_by uuid references staff (id),
  submitted_at timestamptz
);

create table count_lines (
  id uuid primary key default gen_random_uuid(),
  count_id uuid not null references counts (id),
  item_id uuid not null references items (id),
  expected numeric(14,3) not null,
  counted numeric(14,3),
  counted_by uuid references staff (id),
  counted_at timestamptz,
  applied numeric(14,3),
  unique (count_id, item_id)
);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid references staff (id),
  device_id uuid,
  session_user_id uuid,
  action text not null,
  entity text,
  entity_id text,
  detail jsonb not null default '{}'
);
create index audit_log_at on audit_log (at);

-- Seed: the main location and the default categories (the Mac app's list).
insert into locations (name, kind) values ('Main kitchen', 'kitchen');
insert into categories (name, prefix) values
  ('Dry Goods','DRY'), ('Produce','PRD'), ('Proteins','PRO'), ('Dairy','DAI'), ('Frozen','FRZ'),
  ('Beverages','BEV'), ('Bakery','BAK'), ('Cleaning','CLN'), ('Paper & Disposables','PPR'),
  ('Equipment','EQP'), ('Donation','DON'), ('Other','OTH');

create or replace function hk_schema_version() returns int language sql immutable as $$ select 1 $$;

select 'part 0001 applied' as proof, (select count(*) from categories) as categories, hk_schema_version() as version;
