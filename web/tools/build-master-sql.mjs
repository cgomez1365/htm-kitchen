/**
 * Builds supabase/master.sql: the whole schema as ONE file to paste into the Supabase SQL
 * Editor of an EMPTY Hope Kitchen project (CEO 2026-10-31: "master.sql ... include
 * sanitation and prompt rejection and security steps").
 *
 *   npm run sql:master            write supabase/master.sql from migrations 0001-NNNN
 *   npm run sql:master -- --check exit 1 if master.sql is out of date (test:sql runs this)
 *
 * WHY THE EDITOR NEEDS CARE (FQC, 2026-09-21). The SQL Editor splits a script with its own
 * parser, and that parser is not Postgres's: FQC's scripts came back "Success. No rows
 * returned" while applying nothing, then "syntax error" on a fragment that began mid-statement.
 * The cause was a semicolon inside an ordinary '...' string. Dollar quoting ($$...$$) it
 * handles. So the file is SANITISED for the editor:
 *   * every comment outside a function body is removed (a ';' in a comment is the same trap);
 *   * a '...' string outside a function body that holds a ';' is re-quoted as $hkq$...$hkq$
 *     (the same string to Postgres; an E'...' one stops the build instead, for a person to decide);
 *   * test:sql then splits master.sql the WORST way an editor could (on every ';' outside
 *     dollar quotes, blind to strings and comments) and runs the pieces one by one on a fresh
 *     database: if any piece is a fragment, the test fails.
 *
 * WHAT IT REFUSES (the "prompt rejection"): the first statement inside the transaction checks
 * where it is running, and stops the whole file, changing nothing, if
 *   * Hope Kitchen is already installed there (updates go through npm run db:apply),
 *   * the project already has other tables (FQC's project is Hope's: never paste this there),
 *   * there is no auth schema (not a Supabase project).
 *
 * SECURITY STEPS: everything runs in one transaction that ends with supabase/security_check.sql.
 * If any rule fails (RLS off, a write policy, a door open to signed-out visitors...), the
 * check raises, and the whole install rolls back: a half-secure schema is never left behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUPA = path.resolve(HERE, '../../supabase');
const MIG = path.join(SUPA, 'migrations');
export const MASTER = path.join(SUPA, 'master.sql');

const TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/** Cut SQL into code, '...' strings, $tag$ bodies, -- and block comments. */
export function scan(sql) {
  const out = [];
  let i = 0, code = '';
  const flush = () => { if (code) out.push({ type: 'code', text: code }); code = ''; };
  while (i < sql.length) {
    const c = sql[i], rest = sql.slice(i);
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i); const stop = end < 0 ? sql.length : end;
      flush(); out.push({ type: 'comment', text: sql.slice(i, stop) }); i = stop; continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2); if (end < 0) throw new Error('unclosed /* comment');
      flush(); out.push({ type: 'comment', text: sql.slice(i, end + 2) }); i = end + 2; continue;
    }
    if (c === "'") {
      const escaped = /[Ee]$/.test(code) && !/[A-Za-z0-9_][Ee]$/.test(code);
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new Error('unclosed string');
        if (escaped && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      flush(); out.push({ type: escaped ? 'estring' : 'string', text: sql.slice(i, j + 1) }); i = j + 1; continue;
    }
    const m = c === '$' && !/[A-Za-z0-9_]$/.test(code) ? TAG.exec(rest) : null;
    if (m) {
      const end = sql.indexOf(m[0], i + m[0].length); if (end < 0) throw new Error(`unclosed ${m[0]} body`);
      flush(); out.push({ type: 'dollar', text: sql.slice(i, end + m[0].length) }); i = end + m[0].length; continue;
    }
    code += c; i++;
  }
  flush();
  return out;
}

/** The same SQL, safe for an editor that splits on ';' without understanding strings or comments. */
export function sanitize(sql, name = 'sql') {
  return scan(sql).map((p) => {
    if (p.type === 'comment') return '';
    if (p.type === 'estring' && p.text.includes(';')) throw new Error(`${name}: an E'...' string holds a ';' (${p.text.slice(0, 60)}); re-quote it by hand`);
    if (p.type === 'string' && p.text.includes(';')) {
      const inner = p.text.slice(1, -1).replace(/''/g, "'");
      if (inner.includes('$hkq$')) throw new Error(`${name}: a string holds $hkq$`);
      return `$hkq$${inner}$hkq$`;
    }
    return p.text;
  }).join('').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The worst editor: cuts on every ';' outside dollar quotes, blind to strings and comments. */
export function naiveSplit(sql) {
  const parts = [];
  let i = 0, start = 0;
  while (i < sql.length) {
    const m = sql[i] === '$' && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? '') ? TAG.exec(sql.slice(i)) : null;
    if (m) { const end = sql.indexOf(m[0], i + m[0].length); i = end < 0 ? sql.length : end + m[0].length; continue; }
    if (sql[i] === ';') { parts.push(sql.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(sql.slice(start));
  return parts.map((s) => s.trim()).filter(Boolean);
}

export function buildMaster() {
  const files = fs.readdirSync(MIG).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  const last = files[files.length - 1].slice(0, 4);
  const guard = `do $guard$
begin
  if to_regproc('public.hk_schema_version') is not null then
    raise exception 'Hope Kitchen is already installed in this project (schema %). master.sql is only for an EMPTY project; update with npm run db:apply. Nothing was changed.', public.hk_schema_version();
  end if;
  if exists (select 1 from pg_tables where schemaname = 'public') then
    raise exception 'This project already has tables that are not Hope Kitchen''s (%). Refusing: open the Hope Kitchen project. Nothing was changed.',
      (select string_agg(tablename, ', ') from (select tablename from pg_tables where schemaname = 'public' order by 1 limit 5) t);
  end if;
  if to_regnamespace('auth') is null then
    raise exception 'There is no auth schema here, so this is not a Supabase project. Nothing was changed.';
  end if;
end $guard$`;
  const header = [
    '-- Hope Kitchen: the whole database, for the Supabase SQL Editor of an EMPTY project',
    `-- Generated from supabase/migrations 0001-${last} and supabase/security_check.sql by web/tools/build-master-sql.mjs`,
    '-- Do not edit this file: edit the migrations and run npm run sql:master',
    '-- Paste ALL of it into SQL Editor and press Run once. The last line says the schema version and that the security check passed',
    '-- It refuses (and changes nothing) in a project that already has Hope Kitchen or any other tables',
    '-- Comments inside function bodies stay. Comments outside them were removed for the editor, see the migrations for the reasons',
  ].join('\n');
  const body = files.map((f) => `-- ${f}\n${sanitize(fs.readFileSync(path.join(MIG, f), 'utf8'), f)}`).join('\n\n');
  const check = sanitize(fs.readFileSync(path.join(SUPA, 'security_check.sql'), 'utf8'), 'security_check.sql');
  return `${header}\n\nbegin;\n\n${guard};\n\n${body}\n\n-- security check, inside the same transaction: if it fails, nothing above is kept\n${check}\n\ncommit;\n\nselect 'Hope Kitchen schema ' || public.hk_schema_version() || ' installed, security check passed' as result;\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = buildMaster();
  if (process.argv.includes('--check')) {
    const now = fs.existsSync(MASTER) ? fs.readFileSync(MASTER, 'utf8') : '';
    if (now !== next) { console.error('supabase/master.sql is out of date: run npm run sql:master'); process.exit(1); }
    console.log('supabase/master.sql is up to date');
  } else {
    fs.writeFileSync(MASTER, next);
    console.log(`wrote supabase/master.sql (${next.split('\n').length} lines, ${naiveSplit(next).length} statements)`);
  }
}
