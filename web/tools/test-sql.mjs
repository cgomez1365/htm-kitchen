/**
 * The database's own rules, run against a real Postgres (PGlite), as real users.
 *
 *   npm run test:sql        (from web/)
 *
 * Copied in shape from FQC's tools/test-sql.mjs (2026-10-29): Row Level Security
 * and the doors are this app's security boundary, so a typecheck and a build prove
 * nothing about them. Every migration is applied in order, then the rules are
 * exercised as a Director, an Inventory Manager, a kitchen tablet with a chef
 * unlocked by PIN, a second tablet at another location, a stray signed-in user,
 * and nobody at all. A refusal is asserted as a refusal and a permission as a
 * permission: a rule that refuses everything passes half a test suite and breaks the app.
 * The cases carry over the Mac app's self-test (Sources/Tests.swift).
 */
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.resolve(HERE, '../../supabase/migrations');
const { STUBS } = createRequire(import.meta.url)('./pg-stubs.js');
const files = fs.readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const SCHEMA_VERSION = Number(files[files.length - 1].slice(0, 4));

const db = new PGlite({ extensions: { pgcrypto } });
let failed = 0;
const ok = (m) => console.log('  ok    ' + m);
const bad = (m) => { failed++; console.log('  FAIL  ' + m); };
const check = (cond, m, extra = '') => (cond ? ok(m) : bad(`${m}${extra ? '  — ' + extra : ''}`));

await db.exec(STUBS);
console.log('\n1. Every migration, in order');
for (const f of files) {
  try { await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8')); ok(f); }
  catch (e) { bad(`${f}  — ${e.message}`); process.exit(1); }
}

// ---------------------------------------------------------------- fixtures --
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DIR = id(1), INV = id(2), TAB = id(3), TAB2 = id(4), STRAY = id(5);
await db.exec(`insert into auth.users (id, email) values
  ('${DIR}','dir@x'),('${INV}','inv@x'),('${TAB}','tab@x'),('${TAB2}','tab2@x'),('${STRAY}','stray@x');`);

// uid: a user id acts as that signed-in user; null acts as anon; undefined acts as the owner (fixtures, owner-proof checks).
async function as(uid, fn) {
  if (uid === undefined) return fn();
  const role = uid === null ? 'anon' : 'authenticated';
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${role};`);
  try { return await fn(); } finally { await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`); }
}
const one = async (uid, sql, params = []) => (await as(uid, () => db.query(sql, params))).rows[0];
const rows = async (uid, sql, params = []) => (await as(uid, () => db.query(sql, params))).rows;
async function refuses(label, uid, sql, params = []) {
  try {
    const r = await as(uid, () => db.query(sql, params));
    if ((r.affectedRows ?? 0) === 0 && !/^\s*(insert|select)/i.test(sql)) return ok(`${label}  (0 rows)`);
    bad(`${label}  — it was ALLOWED`);
  } catch (e) { ok(`${label}  (${e.message.slice(0, 70)})`); }
}
let n = 1000;
const uid = () => id(n++);
const now = () => new Date().toISOString();
const move = (who, tok, item, loc, kind, qty, extra = {}) =>
  one(who, `select * from record_move($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [extra.id ?? uid(), tok, extra.at ?? now(), item, loc, kind, qty, extra.reason ?? null, extra.note ?? null, null]);

console.log('\n2. Setup and people');
const MAIN = (await one(undefined, `select id from locations where name = 'Main kitchen'`)).id;
await refuses('nobody becomes Director without signing in', null, `select bootstrap_first_director('X')`);
const dirStaff = (await one(DIR, `select bootstrap_first_director('Maria Lopez') as id`)).id;
check(!!dirStaff, 'the first session on an empty database becomes the Director');
await refuses('a second session cannot become Director', STRAY, `select bootstrap_first_director('Stray')`);
const chef = (await one(DIR, `select save_staff('{"display_name":"James Carter","role":"chef"}') as id`)).id;
const staff1 = (await one(DIR, `select save_staff('{"display_name":"Ana Ruiz","role":"staff"}') as id`)).id;
await one(DIR, `select save_staff('{"display_name":"Ivy Inventory","role":"inventory","email":"inv@x"}')`);
await refuses('a manager needs an email', DIR, `select save_staff('{"display_name":"No Mail","role":"inventory"}')`);
await one(DIR, `select set_pin($1, '1357')`, [chef]);
await refuses('a PIN is 4 to 8 digits', DIR, `select set_pin($1, '12')`, [chef]);
check((await one(INV, `select claim_my_staff() as ok`)).ok === true, 'an Inventory Manager links their sign-in by email');
await refuses('an Inventory Manager cannot manage people', INV, `select save_staff('{"display_name":"Z","role":"staff"}')`);
await refuses('an Inventory Manager cannot set PINs', INV, `select set_pin($1, '9999')`, [chef]);
const WALK = (await one(DIR, `select save_location('{"name":"Walk-in cooler","kind":"storage"}') as id`)).id;
await one(DIR, `select register_device('tab@x', 'Kitchen iPad', array[$1]::uuid[])`, [MAIN]);
await one(DIR, `select register_device('tab2@x', 'Walk-in iPad', array[$1]::uuid[])`, [WALK]);
await refuses('a person\'s sign-in cannot be registered as a tablet', DIR, `select register_device('inv@x', 'Nope', '{}')`);

console.log('\n3. Catalogue');
const saltId = (await one(DIR, `select save_item('{"name":"Kosher Salt","category":"Dry Goods","unit":"boxes","min_level":5,"price":12.5,"opening":12}') as id`)).id;
const salt = await one(DIR, `select * from stock where id = $1`, [saltId]);
check(salt.sku === 'DRY-0001', 'first Dry Goods SKU is DRY-0001', salt.sku);
check(Number(salt.on_hand) === 12, 'opening count puts 12 on hand');
const oilId = (await one(INV, `select save_item('{"name":"Olive Oil","category":"Dry Goods","unit":"gallons","barcode":"0123456789012"}') as id`)).id;
check((await one(INV, `select sku from items where id = $1`, [oilId])).sku === 'DRY-0002', 'SKUs count up per category');
await one(DIR, `select add_code($1, '10012345000017', 24, 'Case of 24')`, [saltId]);
await refuses('one barcode cannot belong to two items', DIR, `select add_code($1, '10012345000017', 1, null)`, [oilId]);
await refuses('our own label is not a maker barcode', DIR, `select add_code($1, 'HK1:DRY-0001', 1, null)`, [oilId]);
await refuses('an unknown category is refused', DIR, `select save_item('{"name":"X","category":"Nope","unit":"pcs"}')`);

console.log('\n4. The tablet and the PIN');
const roster = await rows(TAB, `select * from tablet_roster()`);
check(roster.some((r) => r.display_name === 'James Carter' && r.has_pin), 'the tablet lists people, and who has a PIN');
check(!('email' in (roster[0] || {})), 'the roster never carries emails');
check((await rows(TAB, `select * from staff`)).length === 0, 'a tablet cannot read the staff table');
const wrong = await one(TAB, `select * from tablet_sign_in($1, '0000')`, [chef]);
check(wrong.refused && wrong.reason === 'Wrong PIN.', 'a wrong PIN is refused (as a row)');
const signIn = await one(TAB, `select * from tablet_sign_in($1, '1357')`, [chef]);
check(!signIn.refused && signIn.token?.length === 48, 'the right PIN unlocks the chef for 12 hours');
const TOK = signIn.token;
check((await one(DIR, `select (tablet_sign_in($1, '1357')).reason as r`, [chef])).r?.startsWith('Only a kitchen tablet'), 'a manager session cannot use the PIN door');

console.log('\n5. Scanning');
const sid = uid();
const out1 = await move(TAB, TOK, saltId, MAIN, 'issue', 3, { id: sid, reason: 'Kitchen use' });
check(!out1.refused && Number(out1.here) === 9, 'the chef scans out 3: 9 left', JSON.stringify(out1));
const again = await move(TAB, TOK, saltId, MAIN, 'issue', 3, { id: sid });
check(again.duplicate && Number(again.here) === 9, 'the same scan sent twice is one movement (offline retry)');
check((await move(TAB, null, saltId, MAIN, 'issue', 1)).reason?.includes('PIN'), 'no PIN, no scan');
check((await move(TAB2, TOK, saltId, WALK, 'issue', 1)).refused, 'a token from one tablet does not work on another');
check((await move(TAB, TOK, saltId, WALK, 'issue', 1)).refused, 'a tablet cannot move stock at a location it is not tied to');
check((await move(TAB, TOK, saltId, MAIN, 'receive', 1)).reason?.includes('can\'t do that'), 'a chef cannot receive deliveries');
check((await move(TAB, TOK, saltId, MAIN, 'issue', 1, { at: new Date(Date.now() - 2 * 864e5).toISOString() })).refused, 'a scan dated two days ago is refused');
const over = await move(TAB, TOK, saltId, MAIN, 'issue', 50);
check(over.refused && over.reason.includes('Only 9 on hand'), 'taking more than is on hand is refused until the rule is decided', over.reason);
const refusedRows = (await one(DIR, `select count(*)::int as c from audit_log where action = 'refused.move'`)).c;
check(refusedRows >= 5, 'every refused scan left an audit row', String(refusedRows));
const undo = await one(TAB, `select * from undo_move($1,$2,$3,$4)`, [uid(), TOK, now(), sid]);
check(!undo.refused && Number(undo.here) === 12, 'the chef undoes their own scan: back to 12');
check((await one(TAB, `select * from undo_move($1,$2,$3,$4)`, [uid(), TOK, now(), sid])).reason === 'Already undone.', 'a scan is undone only once');
const rec = await move(INV, null, saltId, MAIN, 'receive', 6);
check(!rec.refused && Number(rec.total) === 18, 'an Inventory Manager receives 6 from the portal (no PIN needed)');
const trf = await one(TAB, `select * from record_transfer($1,$2,$3,$4,$5,$6,$7,$8,null)`, [uid(), uid(), TOK, now(), saltId, MAIN, WALK, 4]);
check(!trf.refused && Number(trf.here) === 14 && Number(trf.total) === 18, 'move 4 to the walk-in: 14 here, 18 in all', JSON.stringify(trf));
const walkLevel = await one(TAB2, `select on_hand from stock_levels where item_id = $1 and location_id = $2`, [saltId, WALK]);
check(Number(walkLevel?.on_hand) === 4, 'the walk-in tablet sees the 4 arrive');
check((await rows(TAB2, `select * from stock_levels where location_id = $1`, [MAIN])).length === 0, 'the walk-in tablet cannot see the main kitchen\'s stock');
check((await one(TAB, `select * from record_count($1,$2,$3,$4,$5,$6,null)`, [uid(), TOK, now(), saltId, MAIN, 10])).refused, 'a chef cannot post a shelf count');
const cnt = await one(INV, `select * from record_count($1,null,$2,$3,$4,$5,null)`, [uid(), now(), saltId, MAIN, 10]);
check(Number(cnt.here) === 10, 'a shelf count of 10 sets the main kitchen to 10');

console.log('\n6. Nothing disappears, nothing is written around the doors');
await refuses('a Director cannot insert a movement directly', DIR,
  `insert into movements (id,item_id,location_id,qty,kind,actor_id,session_user_id,happened_at) values ($1,$2,$3,5,'receive',$4,$5,now())`, [uid(), saltId, MAIN, dirStaff, DIR]);
await refuses('a Director cannot edit stock levels', DIR, `update stock_levels set on_hand = 999`);
await refuses('a Director cannot edit an item behind the door', DIR, `update items set price = 0`);
await refuses('even the owner cannot delete a movement', undefined, `delete from movements`);
await refuses('even the owner cannot edit a movement', undefined, `update movements set qty = 1`);
await refuses('even the owner cannot delete an item', undefined, `delete from items`);
await refuses('stock levels cannot be set by hand, even by the owner', undefined, `update stock_levels set on_hand = 1`);
await refuses('nobody truncates the audit log', undefined, `truncate audit_log`);
check((await rows(undefined, `select * from verify_stock()`)).length === 0, 'the maintained stock matches the ledger exactly');

console.log('\n7. Strangers');
check((await rows(null, `select * from items`).catch(() => [])).length === 0, 'anon reads no items');
check((await rows(STRAY, `select * from items`)).length === 0, 'a signed-in stranger reads no items');
check((await rows(STRAY, `select * from movements`)).length === 0, 'a signed-in stranger reads no movements');
await refuses('anon cannot search', null, `select item_search('{}')`);
await refuses('anon cannot scan', null, `select record_move($1,null,now(),$2,$3,'issue',1,null,null,null)`, [uid(), saltId, MAIN]);
const priv = await one(undefined, `select
  has_function_privilege('anon','record_move(uuid,text,timestamptz,uuid,uuid,text,numeric,text,text,text)','execute') as a1,
  has_function_privilege('anon','tablet_sign_in(uuid,text)','execute') as a2,
  has_function_privilege('anon','tablet_roster()','execute') as a3,
  has_function_privilege('authenticated','resolve_actor(text,timestamptz)','execute') as s1,
  has_function_privilege('authenticated','write_audit(uuid,uuid,text,text,text,jsonb)','execute') as s2,
  has_function_privilege('authenticated','verify_stock()','execute') as s3`);
check(!priv.a1 && !priv.a2 && !priv.a3, 'no door is open to anon');
check(!priv.s1 && !priv.s2 && !priv.s3, 'internal helpers are closed to signed-in sessions too');
check((await rows(TAB, `select * from staff_pins`).catch(() => [])).length === 0, 'nobody reads PIN hashes');

console.log('\n8. PIN throttle');
await one(DIR, `select set_pin($1, '2468')`, [staff1]);
for (let i = 0; i < 5; i++) await one(TAB, `select * from tablet_sign_in($1, '0000')`, [staff1]);
const locked = await one(TAB, `select * from tablet_sign_in($1, '2468')`, [staff1]);
check(locked.locked, 'after 5 wrong PINs even the right one waits 15 minutes');
await refuses('a session cannot forge PIN attempts to lock someone out', TAB, `insert into pin_attempts (staff_id, device_id, ok) values ($1,$2,false)`, [chef, TAB]);
check((await one(TAB, `select tablet_sign_out($1) as ok`, [TOK])).ok === true, 'signing out ends the tablet session');
check((await move(TAB, TOK, saltId, MAIN, 'issue', 1)).refused, 'a scan after sign-out is refused');

console.log('\n9. What the screens read');
const s1 = await one(TAB, `select item_search('{"q":"salt"}') as r`);
check(s1.r.total === 1, 'search finds salt by name');
const page = await one(DIR, `select item_search('{"limit":1,"sort":"sku"}') as r`);
check(page.r.rows.length === 1 && page.r.total === 2, 'search pages: 1 of 2');
const look = await one(TAB, `select lookup_code('HK1:DRY-0001', $1) as r`, [MAIN]);
check(look.r.found && Number(look.r.item.here) === 10, 'our label resolves, with stock here');
const caseLook = await one(TAB, `select lookup_code('10012345000017', $1) as r`, [MAIN]);
check(Number(caseLook.r.packQty) === 24, 'a case barcode reports a pack of 24');
check((await one(TAB, `select lookup_code('nothing') as r`)).r.found === false, 'an unknown code says not found');
const feed = await one(TAB, `select movement_feed($1, null, 50) as r`, [MAIN]);
check(feed.r.length > 0 && feed.r.every((m) => m.location_name === 'Main kitchen') && feed.r.some((m) => m.person_name === 'James Carter'),
  'the feed shows names, only for the tablet\'s location');
const det = await one(INV, `select item_detail($1) as r`, [saltId]);
check(det.r.levels.length === 2 && det.r.code_list.length === 1, 'item detail lists every location and its barcodes');
const dash = await one(INV, `select dashboard() as r`);
check(dash.r.items === 2 && dash.r.pulls_today >= 0, 'the dashboard adds up');
const pulls = await one(INV, `select report_pulls('{}') as r`);
check(pulls.r.totals.pulls === 0 && pulls.r.total === 0, 'pull records leave out the undone pull', JSON.stringify(pulls.r.totals));
await refuses('a tablet cannot open reports', TAB, `select report_pulls('{}') as r where true`);

const wTab = (await one(TAB, `select whoami() as r`)).r;
check(wTab.device?.name === 'Kitchen iPad' && wTab.manager === null && wTab.locations.length === 1, 'whoami: the tablet and its one location');
const wDir = (await one(DIR, `select whoami() as r`)).r;
check(wDir.manager?.role === 'director' && wDir.locations.length === 2 && wDir.setup_needed === false, 'whoami: the Director sees every location');
const wStray = (await one(STRAY, `select whoami() as r`)).r;
check(!wStray.manager && !wStray.device && wStray.locations.length === 0, 'whoami: a stranger is nobody and sees nothing');

console.log('\n10. Admin screens (0007)');
const staffCount = async () => (await one(undefined, `select count(*)::int as c from staff`)).c;
const ivy = (await one(DIR, `select save_staff('{"display_name":"Ivy Park","role":"staff","pin":"4826"}') as id`)).id;
check(!(await one(TAB, `select * from tablet_sign_in($1, '4826')`, [ivy])).refused, 'a person added with a PIN in one call can sign in at once');
const before = await staffCount();
await refuses('a bad PIN refuses the whole save', DIR, `select save_staff('{"display_name":"Half Made","role":"staff","pin":"12a"}')`);
check(await staffCount() === before, 'no half-made person is left behind');
await refuses('two active people cannot share a name', DIR, `select save_staff('{"display_name":"james carter","role":"staff"}')`);
const people = (await one(DIR, `select people_list() as r`)).r;
check(people.some((p) => p.display_name === 'Ivy Park' && p.has_pin && !p.locked), 'the Director sees who has a PIN');
check(people.find((p) => p.id === staff1)?.locked === true, 'the Director sees who is locked out');
await refuses('an Inventory Manager cannot list people', INV, `select people_list()`);
await refuses('a tablet cannot list people', TAB, `select people_list()`);
await refuses('an Inventory Manager cannot unlock a PIN', INV, `select unlock_pin($1)`, [staff1]);
await one(DIR, `select unlock_pin($1)`, [staff1]);
check(!(await one(TAB, `select * from tablet_sign_in($1, '2468')`, [staff1])).refused, 'after a Director unlocks, the right PIN works at once');
for (let i = 0; i < 4; i++) await one(TAB, `select * from tablet_sign_in($1, '0000')`, [ivy]);
await one(TAB, `select * from tablet_sign_in($1, '4826')`, [ivy]);
await one(TAB, `select * from tablet_sign_in($1, '0000')`, [ivy]);
check(!(await one(TAB, `select * from tablet_sign_in($1, '4826')`, [ivy])).locked, 'a right PIN clears the wrong tries before it');
const ivyTok = (await one(TAB, `select * from tablet_sign_in($1, '4826')`, [ivy])).token;
check(!(await move(TAB, ivyTok, saltId, MAIN, 'issue', 1)).refused, 'Ivy scans');
await one(DIR, `select save_staff($1)`, [JSON.stringify({ id: ivy, display_name: 'Ivy Park', role: 'staff', active: false })]);
check((await move(TAB, ivyTok, saltId, MAIN, 'issue', 1)).refused, 'switching a person off ends their tablet session at once');

const tablets = (await one(DIR, `select tablet_list() as r`)).r;
check(tablets.some((t) => t.name === 'Kitchen iPad' && t.locations.length === 1 && t.email === 'tab@x'), 'the Director sees each tablet and its locations');
await refuses('an Inventory Manager cannot list tablets', INV, `select tablet_list()`);
await one(DIR, `select save_device($1)`, [JSON.stringify({ id: TAB2, name: 'Walk-in iPad', locations: [MAIN] })]);
check((await one(TAB2, `select whoami() as r`)).r.locations.map((l) => l.name).join() === 'Main kitchen', 'a location taken from a tablet disappears from it');
check((await rows(TAB2, `select * from stock_levels where location_id = $1`, [WALK])).length === 0, '...and so does its stock');
await one(DIR, `select save_device($1)`, [JSON.stringify({ id: TAB2, name: 'Walk-in iPad', locations: [WALK], active: false })]);
check((await one(TAB2, `select whoami() as r`)).r.device === null, 'a switched-off tablet is nobody');
await one(DIR, `select save_device($1)`, [JSON.stringify({ id: TAB2, name: 'Walk-in iPad', locations: [WALK] })]);
check((await one(TAB2, `select whoami() as r`)).r.locations.map((l) => l.name).join() === 'Walk-in cooler', 'switched back on with its location back');
await refuses('two tablets cannot share a name', DIR, `select save_device($1)`, [JSON.stringify({ id: TAB2, name: 'kitchen ipad', locations: [] })]);

async function asService(fn) { await db.exec(`reset role; set role service_role;`); try { return await fn(); } finally { await db.exec(`reset role;`); } }
const redeem = async (code) => (await asService(() => db.query(`select * from redeem_pairing($1)`, [code]))).rows[0];
await refuses('an Inventory Manager cannot pair a tablet', INV, `select start_pairing($1)`, [TAB2]);
const old = (await one(DIR, `select start_pairing($1) as r`, [TAB2])).r.code;
const pair = (await one(DIR, `select start_pairing($1) as r`, [TAB2])).r;
check(/^[A-HJ-NP-Z2-9]{8}$/.test(pair.code), 'a pairing code is 8 easy-to-read characters', pair.code);
await refuses('a signed-in session cannot redeem a code', DIR, `select * from redeem_pairing($1)`, [pair.code]);
await refuses('anon cannot redeem a code', null, `select * from redeem_pairing($1)`, [pair.code]);
check(!(await redeem(old)), 'a newer code replaces the older one');
const got = await redeem(`${pair.code.slice(0, 4).toLowerCase()}-${pair.code.slice(4)}`);
check(got?.device_id === TAB2 && got?.email === 'tab2@x', 'the server trades the code (any case, with a dash) for the tablet sign-in');
check(!(await redeem(pair.code)), 'a code works once');
const late = (await one(DIR, `select start_pairing($1) as r`, [TAB2])).r.code;
await one(undefined, `update device_pairings set expires_at = now() - interval '1 minute' where closed_at is null`);
check(!(await redeem(late)), 'an expired code does nothing');
check((await rows(TAB, `select * from device_pairings`).catch(() => [])).length === 0, 'nobody reads pairing codes');
await refuses('a PIN unlock is never deleted', undefined, `delete from pin_unlocks`);

const locs = (await one(DIR, `select location_list() as r`)).r;
check(locs.find((l) => l.id === WALK)?.tablets === 1 && locs.find((l) => l.id === MAIN)?.stocked >= 1, 'locations show their stock and tablets');
await refuses('a tablet cannot list every location', TAB, `select location_list()`);
await refuses('two locations cannot share a name', INV, `select save_location('{"name":"walk-in COOLER"}')`);

await one(INV, `select save_category('{"name":"Snacks","prefix":"snk"}')`);
check((await one(INV, `select next_sku('Snacks') as s`)).s === 'SNK-0001', 'a new category gives SKUs from its prefix');
await refuses('a prefix is used once', INV, `select save_category('{"name":"Drinks","prefix":"DRY"}')`);
await refuses('a prefix is 2 to 5 letters', INV, `select save_category('{"name":"Drinks","prefix":"B1"}')`);
await refuses('a category items use keeps its name', INV, `select save_category('{"original":"Dry Goods","name":"Pantry","prefix":"DRY"}')`);
await one(INV, `select save_category('{"original":"Snacks","name":"Snacks","prefix":"SNX"}')`);
check((await one(INV, `select next_sku('Snacks') as s`)).s === 'SNX-0001', 'its prefix can change');
await refuses('a tablet cannot edit categories', TAB, `select save_category('{"name":"X","prefix":"XX"}')`);
check((await one(INV, `select category_list() as r`)).r.find((c) => c.name === 'Dry Goods')?.items >= 2, 'categories show how many items use them');
check((await rows(TAB, `select * from category_names() n`)).some((r) => r.n === 'Snacks'), 'a tablet sees the category names for Items');
check((await rows(STRAY, `select * from category_names() n`)).length === 0, 'a stranger sees no categories');

console.log('\n11. Version');
check((await one(undefined, `select hk_schema_version() as v`)).v === SCHEMA_VERSION, `schema version is ${SCHEMA_VERSION}`);

// The role table exists twice (has_perm in SQL, PERMS in web/src/lib/roles.ts): they must agree (FQC's LADDER trap).
const rolesTs = path.resolve(HERE, '../src/lib/roles.ts');
if (fs.existsSync(rolesTs)) {
  const src = fs.readFileSync(rolesTs, 'utf8');
  const perms = [...src.matchAll(/(\w+):\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2].match(/'(\w+)'/g)?.map((s) => s.slice(1, -1)) ?? []]);
  const sql = await rows(undefined, `select p, array_agg(r::text order by r::text) as roles from unnest(array[${perms.map(([p]) => `'${p}'`).join(',')}]) p,
     unnest(enum_range(null::staff_role)) r where has_perm(r, p) group by p`);
  const sqlMap = Object.fromEntries(sql.map((r) => [r.p, r.roles.sort().join(',')]));
  const off = perms.filter(([p, rs]) => (sqlMap[p] ?? '') !== [...rs].sort().join(','));
  check(off.length === 0, 'the TypeScript role table matches has_perm()', off.map(([p]) => p).join(', '));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
