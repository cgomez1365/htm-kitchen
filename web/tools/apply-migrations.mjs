/**
 * Applies supabase/migrations/ to the live Supabase database over a direct connection,
 * after a verified backup, and prints each migration's proof row.
 *
 *   npm run db:apply                 back up, then apply every migration newer than the database
 *   npm run db:apply -- --dry        connect, say what is there and what would run, change nothing
 *   npm run db:apply -- --pglite=DIR rehearse on a PGlite folder on this Mac (an empty folder gets
 *                                    the Supabase stand-ins first, as test:sql does)
 *
 * Built the way FQC's tools/apply-sql.mjs is (2026-10-31), for the same reason: the SQL Editor
 * splits scripts with its own parser and has reported "Success" while applying nothing (FQC,
 * 2026-09-21). A direct connection sends each file whole, and a failure names the file and line.
 *
 * SET IT UP (owner, once): Supabase -> Project Settings -> Database -> Connection string ->
 * Session pooler URI, with the database password in it, as a line in web/.env.local:
 *   SUPABASE_DB_URL=postgresql://...
 * .env.local is never committed (this repo is public).
 *
 * WHAT IT REFUSES
 *   * a database that already holds tables but no hk_schema_version(): it is somebody else's
 *     (FQC's project is Hope's and must never get these tables);
 *   * a database NEWER than this copy of the code: pull first;
 * Each migration runs in its own transaction: one that fails leaves nothing half-applied, and
 * the ones before it stay applied.
 *
 * THE BACKUP. Before anything is applied to a database that already has Hope Kitchen in it,
 * every row of every public table (and each sign-in's id and email: never a password hash or
 * token) is written as one JSON file BESIDE the repo, never inside it:
 *   Hope_Online/live/hope-kitchen-dumps/2026/2026-11/hk-db_2026-11-02_09-14-03_PST_schema7.json
 * It is written under .partial, read back and hashed, then renamed; a .sha256 sits beside it.
 * Nothing ever overwrites or deletes a dump. A restore tool is not built yet: the file is plain
 * JSON, one array of rows per table.
 *
 * This tool is for the owner's machine. The app never imports it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIG = path.resolve(HERE, '../../supabase/migrations');
const DUMPS = process.env.HK_DUMP_DIR || path.resolve(HERE, '../../../hope-kitchen-dumps');
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const PGLITE = ARGS.find((a) => a.startsWith('--pglite='))?.slice('--pglite='.length);
const files = fs.readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
const NEWEST = Number(files[files.length - 1].slice(0, 4));
const stop = (msg) => Object.assign(new Error(msg), { hk: true });

/** .env.local is not loaded for us: read it, take only what this tool needs. */
function envLocal(key) {
  if (process.env[key]) return process.env[key];
  const file = path.resolve(HERE, '../.env.local');
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.startsWith('#') || !line.includes('=')) continue;
    const at = line.indexOf('=');
    if (line.slice(0, at).trim() === key) return line.slice(at + 1).trim().replace(/^["']|["']$/g, '');
  }
  return undefined;
}

// One shape for both targets: q(sql, params) -> rows; script(sql) -> the last result's rows.
async function open() {
  if (PGLITE) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
    const empty = !fs.existsSync(PGLITE) || fs.readdirSync(PGLITE).length === 0;
    const db = new PGlite(PGLITE, { extensions: { pgcrypto } });
    if (empty) await db.exec(createRequire(import.meta.url)('./pg-stubs.js').STUBS);
    return {
      label: `PGlite rehearsal at ${PGLITE}`,
      q: async (sql, p = []) => (await db.query(sql, p)).rows,
      script: async (sql) => { const r = await db.exec(sql); return r[r.length - 1]?.rows ?? []; },
      begin: () => db.exec('begin'), commit: () => db.exec('commit'), rollback: () => db.exec('rollback'),
      end: () => db.close(),
    };
  }
  const url = envLocal('SUPABASE_DB_URL');
  if (!url) {
    throw stop(['SUPABASE_DB_URL is not set, so there is nothing to connect to.', '',
      'Supabase -> Project Settings -> Database -> Connection string -> Session pooler.',
      'Put the database password in it and add the line to web/.env.local:', '',
      '  SUPABASE_DB_URL=postgresql://...'].join('\n'));
  }
  const { default: pg } = await import('pg');
  // Supabase's pooler presents a chain this client cannot verify; the link is still TLS (as FQC).
  const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const ref = (/postgres\.([a-z0-9]{20})[:@]/.exec(url) || /db\.([a-z0-9]{20})\.supabase/.exec(url) || [])[1];
  return {
    label: `Supabase project ${ref ?? '(ref not in the URL)'}`,
    q: async (sql, p = []) => (await client.query(sql, p)).rows,
    script: async (sql) => { const r = await client.query(sql); return (Array.isArray(r) ? r[r.length - 1] : r)?.rows ?? []; },
    begin: () => client.query('begin'), commit: () => client.query('commit'), rollback: () => client.query('rollback'),
    end: () => client.end(),
  };
}

async function versionOf(db) {
  const has = (await db.q(`select to_regproc('public.hk_schema_version') is not null as ok`))[0].ok;
  return has ? Number((await db.q('select hk_schema_version() as v'))[0].v) : null;
}

const stamp = () => {
  const d = new Date();
  const part = (o) => new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', ...o }).formatToParts(d)
    .reduce((m, x) => ({ ...m, [x.type]: x.value }), {});
  const p = part({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'short' });
  return { ym: [p.year, `${p.year}-${p.month}`], name: `${p.year}-${p.month}-${p.day}_${p.hour}-${p.minute}-${p.second}_${p.timeZoneName}` };
};

async function backup(db, version) {
  const tables = (await db.q(`select tablename from pg_tables where schemaname = 'public' order by tablename`)).map((r) => r.tablename);
  const data = {};
  for (const t of tables) data[t] = (await db.q(`select coalesce(json_agg(x), '[]'::json) as rows from public.${JSON.stringify(t)} x`))[0].rows;
  const users = (await db.q(`select coalesce(json_agg(json_build_object('id', id, 'email', email)), '[]'::json) as u from auth.users`))[0].u;
  const body = JSON.stringify({ app: 'hope-kitchen', schema_version: version, taken_at: new Date().toISOString(),
    note: 'Every row of every public table, plus sign-in ids and emails (no password hashes or tokens).', auth_users: users, tables: data });
  const { ym, name } = stamp();
  const dir = path.join(DUMPS, ...ym);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let file = path.join(dir, `hk-db_${name}_schema${version}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `hk-db_${name}_schema${version}-${n}.json`);
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  fs.writeFileSync(file + '.partial', body, { mode: 0o600 });
  const back = crypto.createHash('sha256').update(fs.readFileSync(file + '.partial')).digest('hex');
  if (back !== hash) throw stop(`The backup did not read back the same (${file}.partial). Nothing was applied.`);
  fs.renameSync(file + '.partial', file);
  fs.writeFileSync(file + '.sha256', `${hash}  ${path.basename(file)}\n`, { mode: 0o600 });
  const count = Object.values(data).reduce((a, r) => a + r.length, 0);
  console.log(`backup: ${count} rows in ${tables.length} tables, ${users.length} sign-ins, read back and checked`);
  console.log(`        ${file}`);
}

let db;
try {
  db = await open();
  console.log(`connected: ${db.label}`);
  const version = await versionOf(db);
  if (version === null) {
    const other = (await db.q(`select tablename from pg_tables where schemaname = 'public' order by tablename limit 5`)).map((r) => r.tablename);
    if (other.length) throw stop(`This database already has tables that are not Hope Kitchen's (${other.join(', ')}). Refusing: point SUPABASE_DB_URL at the Hope Kitchen project.`);
  }
  if (version !== null && version > NEWEST) throw stop(`The database is at schema ${version}, newer than this code (${NEWEST}). Pull the latest code first.`);
  const pending = files.filter((f) => Number(f.slice(0, 4)) > (version ?? 0));
  console.log(`schema now: ${version ?? 'empty'} · this code: ${NEWEST} · to apply: ${pending.length ? pending.join(', ') : 'nothing'}`);
  if (DRY) console.log('--dry: nothing was changed.');
  else if (pending.length) {
    if (version !== null) await backup(db, version);
    else console.log('backup: skipped, the database has no Hope Kitchen data yet');
    for (const f of pending) {
      await db.begin();
      try {
        const proof = (await db.script(fs.readFileSync(path.join(MIG, f), 'utf8')))[0];
        await db.commit();
        console.log(`  ok   ${f}  ${proof ? JSON.stringify(proof) : '(no proof row)'}`);
      } catch (e) {
        await db.rollback().catch(() => {});
        throw stop(`  FAIL ${f}: ${e.message}${e.position ? ` (at character ${e.position})` : ''}\n  ${f} was rolled back; everything before it stays applied.`);
      }
    }
    const after = await versionOf(db);
    console.log(after === NEWEST ? `schema now: ${after}. Done.` : `schema now: ${after}, expected ${NEWEST}: check the proof rows above.`);
    if (after !== NEWEST) process.exitCode = 1;
  }
} catch (e) {
  console.error(e.hk ? e.message : `could not finish: ${e.message}`);
  process.exitCode = 1;
} finally {
  await db?.end().catch(() => {});
}
