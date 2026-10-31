/**
 * Local test server: Hope Kitchen's real database on this Mac, with no Supabase project,
 * no Docker and no account (CEO, 2026-10-29: "option 2").
 *
 *   npm run local:db          (from web/)   then, in another window:   npm run dev:local
 *
 * What it is: the six migrations applied to PGlite (Postgres in Node, the same engine
 * test:sql proves the rules on), saved to web/.local-db so stock survives a restart,
 * and served on http://127.0.0.1:54321 the way Supabase serves it:
 *   POST /rest/v1/rpc/<function>   - each call runs AS the signed-in user (role authenticated,
 *                                    request.jwt.claim.sub), so RLS and the doors decide, as on Supabase
 *   /auth/v1/otp, /verify, /token, /user, /logout - a test-only sign-in. Email codes are NOT
 *                                    emailed: they print here and show at http://127.0.0.1:54321/local
 *
 * What it is not: Supabase. It is for testing on this Mac only. Signatures on its tokens are
 * not checked (it looks tokens up in its own memory), and it listens on 127.0.0.1 only.
 * Flags: --reset wipes .local-db first; --no-seed starts with an empty database.
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const MIG = path.resolve(ROOT, '../supabase/migrations');
const DATA = path.join(ROOT, '.local-db');
const PORT = Number(process.env.HK_LOCAL_PORT ?? 54321);
const args = process.argv.slice(2);

if (args.includes('--reset')) fs.rmSync(DATA, { recursive: true, force: true });
const fresh = !fs.existsSync(path.join(DATA, 'db'));
fs.mkdirSync(DATA, { recursive: true });
const db = new PGlite(path.join(DATA, 'db'), { extensions: { pgcrypto } });

// ------------------------------------------------------------------ schema --
if (fresh) {
  const { STUBS } = createRequire(import.meta.url)('./pg-stubs.js');
  await db.exec(STUBS);
  for (const f of fs.readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
    console.log(`applied ${f}`);
  }
} else {
  const v = (await db.query('select hk_schema_version() as v')).rows[0].v;
  const files = fs.readdirSync(MIG).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort();
  for (const f of files.filter((x) => Number(x.slice(0, 4)) > v)) {
    await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8'));
    console.log(`applied ${f} (new since last run)`);
  }
}

// ------------------------------------------------------------------- auth --
// Sessions are kept in .local-db/sessions.json so a tablet stays signed in across restarts.
const SESS_FILE = path.join(DATA, 'sessions.json');
const sessions = new Map(Object.entries(fs.existsSync(SESS_FILE) ? JSON.parse(fs.readFileSync(SESS_FILE, 'utf8')) : {}));
const saveSessions = () => fs.writeFileSync(SESS_FILE, JSON.stringify(Object.fromEntries(sessions)));
const PASSWORDS_FILE = path.join(DATA, 'passwords.json');
const passwords = fs.existsSync(PASSWORDS_FILE) ? JSON.parse(fs.readFileSync(PASSWORDS_FILE, 'utf8')) : {};
const codes = []; // { email, code, at } - the local "inbox"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
function issue(user) {
  const now = Math.floor(Date.now() / 1000), exp = now + 3600;
  const access = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp, iat: now, aal: 'aal1', session_id: crypto.randomUUID() })}.local`;
  const refresh = crypto.randomBytes(24).toString('hex');
  sessions.set(access, { id: user.id, email: user.email, exp });
  sessions.set('r:' + refresh, { id: user.id, email: user.email });
  saveSessions();
  return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: refresh, user: userJson(user) };
}
const userJson = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, app_metadata: { provider: 'email', providers: ['email'] },
  user_metadata: {}, identities: [], created_at: new Date(0).toISOString(), updated_at: new Date().toISOString(), email_confirmed_at: new Date(0).toISOString() });
async function userByEmail(email) {
  return (await db.query('select id::text, email from auth.users where lower(email) = lower($1)', [String(email ?? '').trim()])).rows[0];
}
function userFromBearer(req) {
  const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const s = sessions.get(tok);
  if (!s || s.exp < Date.now() / 1000) return null;
  return s;
}
async function addUser(email, password) {
  const id = crypto.randomUUID();
  await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [id, email]);
  const u = await userByEmail(email);
  if (password) { passwords[u.id] = crypto.createHash('sha256').update(password).digest('hex'); fs.writeFileSync(PASSWORDS_FILE, JSON.stringify(passwords)); }
  return u;
}

// --------------------------------------------------------------------- rpc --
// One call at a time, each in its own transaction with the caller's role and id, exactly what
// PostgREST does with a Supabase JWT. Arguments are passed as quoted literals so Postgres picks
// the types from the function itself (named notation, as PostgREST sends them).
let chain = Promise.resolve();
const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
const NAME = /^[a-z_][a-z0-9_]*$/;
const lit = (v) => {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return `'{${v.map((x) => `"${String(x).replace(/["\\]/g, '\\$&')}"`).join(',')}}'`;
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `'${s.replace(/'/g, "''")}'`;
};
async function rpc(fn, body, user) {
  if (!NAME.test(fn)) throw Object.assign(new Error('Bad function name'), { code: 'PGRST202', status: 404 });
  const meta = (await db.query(`select p.proretset as set, t.typtype as tt, p.prorettype::regtype::text as rt
    from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = $1`, [fn])).rows[0];
  if (!meta) throw Object.assign(new Error(`Could not find the function public.${fn}`), { code: 'PGRST202', status: 404 });
  const named = Object.entries(body ?? {}).map(([k, v]) => {
    if (!NAME.test(k)) throw Object.assign(new Error('Bad argument name'), { code: 'PGRST100', status: 400 });
    return `${k} => ${lit(v)}`;
  }).join(', ');
  const call = `public.${fn}(${named})`;
  const sql = meta.set ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from ${call} r`
    : (meta.tt === 'c' || meta.rt === 'record') ? `select to_jsonb(r) as v from ${call} r`
    : `select to_jsonb(${call}) as v`;
  return serial(() => db.transaction(async (tx) => {
    await tx.exec(`set local role ${user ? 'authenticated' : 'anon'}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user?.id ?? '']);
    return (await tx.query(sql)).rows[0]?.v ?? null;
  }));
}

// ------------------------------------------------------------------ server --
// JSON always, as PostgREST does - a function that returns text answers "text", quoted (seen 2026-10-29:
// save_item's new id went out unquoted and supabase-js read it as an error). Only the /local page is HTML.
const sendHtml = (res, html) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); };
const send = (res, status, body, origin) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': origin ?? '*', 'Access-Control-Allow-Credentials': 'true', 'Vary': 'Origin',
  });
  res.end(status === 204 ? '' : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } }); });
const statusFor = (code) => code === '42501' ? 403 : code === '23505' ? 409 : code?.startsWith('PGRST2') ? 404 : 400;

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin ?? '*', 'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS', 'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '*', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  try {
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const out = await rpc(url.pathname.slice('/rest/v1/rpc/'.length), req.method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req), userFromBearer(req));
      return send(res, 200, out, origin);
    }
    if (url.pathname === '/auth/v1/otp') {
      const b = await readBody(req), u = await userByEmail(b.email);
      if (!u) return send(res, 422, { code: 'otp_disabled', error_code: 'otp_disabled', msg: 'Signups not allowed for otp' }, origin);
      const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
      codes.unshift({ email: u.email, code, at: new Date().toISOString() });
      console.log(`\n  sign-in code for ${u.email}: ${code}   (also at http://127.0.0.1:${PORT}/local)\n`);
      return send(res, 200, {}, origin);
    }
    if (url.pathname === '/auth/v1/verify') {
      const b = await readBody(req), u = await userByEmail(b.email);
      const hit = u && codes.find((c) => c.email === u.email && c.code === String(b.token) && Date.now() - Date.parse(c.at) < 3600e3);
      if (!hit) return send(res, 403, { code: 'otp_expired', error_code: 'otp_expired', msg: 'Token has expired or is invalid' }, origin);
      codes.splice(codes.indexOf(hit), 1);
      return send(res, 200, issue(u), origin);
    }
    if (url.pathname === '/auth/v1/token') {
      const b = await readBody(req), grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const u = await userByEmail(b.email);
        if (!u || passwords[u.id] !== crypto.createHash('sha256').update(String(b.password ?? '')).digest('hex')) {
          return send(res, 400, { code: 'invalid_credentials', error_code: 'invalid_credentials', msg: 'Invalid login credentials' }, origin);
        }
        return send(res, 200, issue(u), origin);
      }
      if (grant === 'refresh_token') {
        const s = sessions.get('r:' + b.refresh_token);
        if (!s) return send(res, 400, { code: 'refresh_token_not_found', error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }, origin);
        sessions.delete('r:' + b.refresh_token);
        return send(res, 200, issue(s), origin);
      }
      return send(res, 400, { msg: 'unsupported grant_type' }, origin);
    }
    if (url.pathname === '/auth/v1/user') {
      const u = userFromBearer(req);
      return u ? send(res, 200, userJson(u), origin) : send(res, 401, { code: 'bad_jwt', msg: 'invalid JWT' }, origin);
    }
    if (url.pathname === '/auth/v1/logout') {
      sessions.delete((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')); saveSessions();
      return send(res, 204, {}, origin);
    }
    if (url.pathname === '/local' || url.pathname === '/') {
      const users = (await db.query(`select u.email, coalesce(s.display_name, d.name, '—') as who, coalesce(s.role::text, case when d.id is not null then 'tablet' end, 'no role') as role
        from auth.users u left join staff s on s.auth_user_id = u.id left join devices d on d.id = u.id order by 3, 1`)).rows;
      return sendHtml(res, `<!doctype html><meta charset=utf-8><meta http-equiv=refresh content=5><title>Hope Kitchen local</title>
        <body style="font:15px -apple-system;max-width:760px;margin:40px auto;background:#111416;color:#eceff1">
        <h1>Hope Kitchen — local test server</h1><p style="color:#a0a9b0">Not Supabase. Codes are not emailed; they appear here (refreshes every 5 s).</p>
        <h2>Sign-in codes</h2>${codes.length ? codes.slice(0, 10).map((c) => `<p><b style="font:700 28px ui-monospace;color:#f5a524">${c.code}</b> &nbsp; ${c.email} &nbsp; <span style="color:#a0a9b0">${new Date(c.at).toLocaleTimeString()}</span></p>`).join('') : '<p style="color:#a0a9b0">None yet. Ask for one on the Manager tab.</p>'}
        <h2>Sign-ins on this test server</h2><table cellpadding=6>${users.map((u) => `<tr><td>${u.email}</td><td>${u.who}</td><td style="color:#a0a9b0">${u.role}</td></tr>`).join('')}</table>
        <p style="color:#a0a9b0">Tablets sign in with password <b>kitchen</b>. People on a tablet: James Carter PIN 1357, Lee Park PIN 2468, Ana Ruiz PIN 1122.</p></body>`);
    }
    return send(res, 404, { message: 'Not found on the local test server' }, origin);
  } catch (e) {
    const code = e.code ?? 'P0001';
    return send(res, e.status ?? statusFor(code), { code, message: e.message, details: null, hint: null }, origin);
  }
});

// ------------------------------------------------------------------- seed --
// A believable kitchen, created THROUGH THE DOORS as the people who would do it, so the seed
// exercises the same rules the app does.
async function seed() {
  const dir = await addUser('director@hk.local'), inv = await addUser('inventory@hk.local');
  await addUser('ipad@hk.local', 'kitchen'); await addUser('walkin-ipad@hk.local', 'kitchen');
  const as = (u, fn, body) => rpc(fn, body, u);
  await as(dir, 'bootstrap_first_director', { p_name: 'Maria Lopez' });
  await as(dir, 'save_staff', { p: { display_name: 'Ana Ruiz', role: 'inventory', email: 'inventory@hk.local' } });
  await as(inv, 'claim_my_staff', {});
  const james = await as(dir, 'save_staff', { p: { display_name: 'James Carter', role: 'chef' } });
  const lee = await as(dir, 'save_staff', { p: { display_name: 'Lee Park', role: 'staff' } });
  const ana = (await db.query(`select id::text from staff where email = 'inventory@hk.local'`)).rows[0].id;
  await as(dir, 'set_pin', { p_staff: james, p_pin: '1357' });
  await as(dir, 'set_pin', { p_staff: lee, p_pin: '2468' });
  await as(dir, 'set_pin', { p_staff: ana, p_pin: '1122' });
  const main = (await db.query(`select id::text from locations where name = 'Main kitchen'`)).rows[0].id;
  const walk = await as(dir, 'save_location', { p: { name: 'Walk-in cooler', kind: 'storage' } });
  const dry = await as(dir, 'save_location', { p: { name: 'Dry storage', kind: 'storage' } });
  await db.query(`select 1`);
  await rpc('register_device', { p_email: 'ipad@hk.local', p_name: 'Kitchen iPad', p_locations: [main, walk, dry] }, dir);
  await rpc('register_device', { p_email: 'walkin-ipad@hk.local', p_name: 'Walk-in iPad', p_locations: [walk] }, dir);
  const list = {
    'Dry Goods': ['Kosher Salt', 'Olive Oil', 'Long-grain Rice 25 lb', 'All-purpose Flour', 'Black Beans #10', 'Spaghetti', 'Canola Oil', 'Brown Sugar'],
    Produce: ['Roma Tomatoes', 'Yellow Onions', 'Russet Potatoes', 'Carrots', 'Romaine', 'Bananas'],
    Proteins: ['Chicken Thighs', 'Ground Beef 80/20', 'Eggs (15 dz)', 'Turkey Breast'],
    Dairy: ['Whole Milk', 'Shredded Cheddar', 'Butter', 'Yogurt'],
    Cleaning: ['Nitrile Gloves L', 'Sanitizer Tablets', 'Trash Liners 55 gal'],
    'Paper & Disposables': ['Foam Clamshells', '8 oz Cups', 'Foil Pans'],
  };
  let n = 0;
  for (const [cat, names] of Object.entries(list)) for (const name of names) {
    n++;
    const cold = cat === 'Proteins' || cat === 'Dairy' || cat === 'Produce';
    const id = await as(dir, 'save_item', { p: {
      name, category: cat, unit: cold ? (cat === 'Dairy' ? 'gallons' : 'lbs') : 'cases', min_level: 8 + (n % 10), par_level: 30 + (n % 15),
      price: (1.25 + (n % 14) * 1.75).toFixed(2), supplier: ['Sysco', 'Restaurant Depot', 'Smart & Final', 'Local farm'][n % 4],
      spot: `Shelf ${1 + (n % 10)}`, opening: 10 + ((n * 7) % 45), location_id: cold ? walk : dry,
      barcode: n % 3 === 0 ? `0${String(70000000000 + n * 1234567).slice(0, 11)}` : '' } });
    if (name === 'Chicken Thighs') await as(dir, 'add_code', { p_item: id, p_code: '10071234500019', p_pack: 40, p_label: 'Case of 40 lb' });
    if (name === 'Kosher Salt') await as(dir, 'add_code', { p_item: id, p_code: '10012345000017', p_pack: 24, p_label: 'Case of 24' });
  }
  console.log(`seeded: 4 sign-ins, 4 people, 3 locations, ${n} items with opening counts`);
}

if (fresh && !args.includes('--no-seed')) await seed();

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\nHope Kitchen local test server on http://127.0.0.1:${PORT}  (data: ${path.relative(process.cwd(), DATA) || DATA})`);
  console.log(`  manager sign-in: director@hk.local or inventory@hk.local, code shown at http://127.0.0.1:${PORT}/local`);
  console.log(`  tablet sign-in:  ipad@hk.local / kitchen   (people: James 1357, Lee 2468, Ana 1122)\n`);
});
