'use client';
/**
 * Admin: people and PINs, tablets, locations, categories (0007). Built to be frictionless
 * (CEO 2026-10-30): a person is added with their PIN in one save; a tablet is added and paired
 * by pointing its camera at a QR (or typing an 8-character code), so nobody types a password;
 * a locked-out PIN is one tap to unlock. Every rule is the database's: refusals show word for word.
 * People and tablets: Director. Locations and categories: Inventory Manager or Director.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import Shell, { useShell } from '@/components/Shell';
import { api } from '@/lib/api';
import { can, ROLE_NAMES, type Role } from '@/lib/roles';
import { isPreview } from '@/lib/supabase-browser';
import type { AdminLocation, Category, Pairing, Person, Tablet } from '@/lib/types';

type Tab = 'people' | 'tablets' | 'locations' | 'categories';
const ROLES: Role[] = ['chef', 'staff', 'driver', 'inventory', 'director'];
const KINDS: AdminLocation['kind'][] = ['kitchen', 'storage', 'site', 'vehicle'];
const isManagerRole = (r: Role) => r === 'director' || r === 'inventory';
const needsPin = (p: Person) => p.active && !p.has_pin && !isManagerRole(p.role);

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60e3);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};
// 4 digits, never all the same or a straight run (1234, 9876): the first PINs people would guess.
const makePin = () => {
  for (;;) {
    const p = String(crypto.getRandomValues(new Uint32Array(1))[0] % 10000).padStart(4, '0');
    const d = [...p].map(Number), step = d[1] - d[0];
    if (!d.every((x, i) => i === 0 || x - d[i - 1] === step) || Math.abs(step) > 1) return p;
  }
};
const suggestPrefix = (name: string, taken: Set<string>) => {
  const letters = name.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length < 2) return '';
  for (const p of [letters.slice(0, 3), letters[0] + letters.slice(-2), letters.slice(0, 4), letters.slice(0, 2)]) if (p.length >= 2 && !taken.has(p)) return p;
  return '';
};

const TONES = { out: 'bg-out/10 text-out', inc: 'bg-inc/10 text-inc', warn: 'bg-warn/10 text-warn' }; // whole class names, so Tailwind keeps them
function Msg({ text, tone = 'out' }: { text: string | null; tone?: keyof typeof TONES }) {
  if (!text) return null;
  return <p className={`rounded-xl px-3 py-2 text-sm font-semibold ${TONES[tone]}`}>{text}</p>;
}

function useList<T>(load: () => Promise<T[]>) {
  const [rows, setRows] = useState<T[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => load().then((r) => { setRows(r ?? []); setErr(null); }).catch((e: Error) => setErr(e.message)), [load]);
  useEffect(() => { reload(); }, [reload]);
  return { rows, err, reload };
}

// ------------------------------------------------------------------ people --

function PersonForm({ person, onDone, onCancel }: { person?: Person; onDone: (msg: string) => void; onCancel: () => void }) {
  const [name, setName] = useState(person?.display_name ?? '');
  const [role, setRole] = useState<Role>(person?.role ?? 'chef');
  const [email, setEmail] = useState(person?.email ?? '');
  const [pin, setPin] = useState(person ? '' : makePin());
  const [active, setActive] = useState(person?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.savePerson({ id: person?.id, display_name: name, role, email, pin, active });
      const parts = [`${name.trim()} is saved.`];
      if (pin) parts.push(`PIN ${pin}: tell them now, it is not shown again.`);
      if (isManagerRole(role) && active) {
        try { await api.ensureManagerSignIn(email); parts.push(`They sign in with ${email.trim().toLowerCase()}: a 6-digit code arrives by email.`); }
        catch (e) { parts.push(`Their sign-in could not be made yet (${(e as Error).message}).`); }
      }
      onDone(parts.join(' '));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card space-y-3 border-accent/40">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block"><span className="label-sm">Name, as the tablet shows it</span>
          <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus={!person} placeholder="James Carter" /></label>
        <label className="block"><span className="label-sm">PIN {person && '(blank keeps the current one)'}</span>
          <div className="mt-1 flex gap-2">
            <input className="field tnum tracking-[.3em]" inputMode="numeric" maxLength={8} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder={person?.has_pin ? '••••' : ''} />
            <button type="button" className="btn shrink-0" onClick={() => setPin(makePin())}>Make one</button>
          </div></label>
      </div>
      <div><span className="label-sm">Role</span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {ROLES.map((r) => (
            <button key={r} type="button" onClick={() => setRole(r)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${role === r ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted'}`}>{ROLE_NAMES[r]}</button>
          ))}
        </div></div>
      {isManagerRole(role) && (
        <label className="block"><span className="label-sm">Email (how a manager signs in)</span>
          <input className="field mt-1" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@hopethemission.org" /></label>
      )}
      {person && !person.is_me && (
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active {!active && <span className="font-normal text-muted">(switched off: off every tablet at once; their records stay)</span>}</label>
      )}
      <Msg text={err} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy || !name.trim() || (isManagerRole(role) && !email.includes('@'))} onClick={save}>{person ? 'Save' : 'Add person'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function People() {
  const { rows, err, reload } = useList<Person>(api.people);
  const [q, setQ] = useState('');
  const [show, setShow] = useState<'active' | 'attention' | 'off'>('active');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);

  const list = useMemo(() => (rows ?? []).filter((p) =>
    (show === 'off' ? !p.active : p.active && (show === 'active' || p.locked || needsPin(p))) &&
    (!q || p.display_name.toLowerCase().includes(q.toLowerCase()))), [rows, q, show]);
  const attention = (rows ?? []).filter((p) => p.active && (p.locked || needsPin(p))).length;
  const done = (msg: string) => { setEditing(null); setNote(msg); reload(); };
  const unlock = (p: Person) => api.unlockPin(p.id).then(() => { setNote(`${p.display_name} is unlocked and can try their PIN again.`); reload(); }).catch((e: Error) => setRowErr(e.message));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input className="field max-w-xs" placeholder="Find a person" value={q} onChange={(e) => setQ(e.target.value)} />
        {([['active', 'Active'], ['attention', `Needs attention${attention ? ` (${attention})` : ''}`], ['off', 'Switched off']] as const).map(([k, l]) => (
          <button key={k} onClick={() => setShow(k)} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${show === k ? 'bg-accent/15 text-accent' : 'text-muted'}`}>{l}</button>
        ))}
        <button className="btn-primary ml-auto" onClick={() => { setEditing('new'); setNote(null); }}>Add person</button>
      </div>
      <Msg text={note} tone="inc" /><Msg text={err ?? rowErr} />
      {editing === 'new' && <PersonForm onDone={done} onCancel={() => setEditing(null)} />}
      {rows && list.length === 0 && <p className="card text-muted">Nobody here.</p>}
      <div className="space-y-2">
        {list.map((p) => editing === p.id ? <PersonForm key={p.id} person={p} onDone={done} onCancel={() => setEditing(null)} /> : (
          <div key={p.id} className="card flex flex-wrap items-center gap-3 py-3">
            <div className="grid h-9 w-9 place-items-center rounded-full bg-surface2 font-bold">{p.display_name[0]}</div>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{p.display_name} {p.is_me && <span className="text-xs text-muted">(you)</span>}</div>
              <div className="text-xs text-muted">{ROLE_NAMES[p.role]}{p.email ? ` · ${p.email}` : ''} · last scan {ago(p.last_scan)}</div>
            </div>
            {p.on_tablet && <span className="pill bg-info/15 text-info">On a tablet now</span>}
            {isManagerRole(p.role) && !p.linked && p.active && <span className="pill bg-surface2 text-muted" title="Linked the first time they sign in">Not signed in yet</span>}
            {needsPin(p) && <span className="pill bg-warn/15 text-warn" title="Cannot sign in on a tablet until a PIN is set">No PIN</span>}
            {p.locked && <button className="pill bg-out/15 text-out" onClick={() => unlock(p)}>Locked · Unlock</button>}
            <button className="btn py-1.5 text-sm" onClick={() => { setEditing(p.id); setNote(null); }}>Edit</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- tablets --

function PairingCard({ tabletId, name, pairing, onClose, onPaired }: { tabletId: string; name: string; pairing: Pairing; onClose: () => void; onPaired: () => void }) {
  const [qr, setQr] = useState('');
  const [left, setLeft] = useState(0);
  const [paired, setPaired] = useState(false);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const link = `${origin}/login#pair=${pairing.code}`;
  const localOnly = /\/\/(127\.0\.0\.1|localhost)/.test(origin);

  useEffect(() => { QRCode.toDataURL(link, { margin: 1, width: 260, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr('')); }, [link]);
  useEffect(() => {
    const started = Date.now();
    let tick = 0;
    setLeft(Math.max(0, Math.round((Date.parse(pairing.expires_at) - Date.now()) / 1000)));
    const t = setInterval(async () => {
      setLeft(Math.max(0, Math.round((Date.parse(pairing.expires_at) - Date.now()) / 1000)));
      if (++tick % 3 === 0) { // every 3 s: has the tablet come in?
        const me = (await api.tablets().catch(() => [] as Tablet[])).find((x) => x.id === tabletId);
        if (me?.paired_at && Date.parse(me.paired_at) >= started - 5000) { setPaired(true); clearInterval(t); onPaired(); }
      }
    }, 1000);
    return () => clearInterval(t);
  }, [pairing.expires_at, tabletId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (paired) return (
    <div className="card border-inc/50 bg-inc/5">
      <p className="text-lg font-bold text-inc">{name} is paired.</p>
      <p className="mt-1 text-sm text-muted">On the tablet, people tap their name and enter their PIN. Nothing else to set up.</p>
      <button className="btn mt-3" onClick={onClose}>Done</button>
    </div>
  );
  return (
    <div className="card flex flex-wrap items-center gap-5 border-accent/50">
      {qr && <img src={qr} alt={`Pairing QR for ${name}`} className="h-44 w-44 rounded-xl bg-white p-2" />}
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-bold">Pair {name}</p>
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>On the tablet, open the Camera and point it at this code, then tap the link.</li>
          <li>Or open <b>{origin}/login</b> on it, tap <b>Kitchen tablet</b> and type:</li>
        </ol>
        <p className="tnum font-mono text-3xl font-black tracking-[.15em] text-accent">{pairing.code.slice(0, 4)}-{pairing.code.slice(4)}</p>
        <p className="text-xs text-muted">{left > 0 ? `Works once, for ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} more.` : 'This code has expired. Make a new one.'} This screen turns green when the tablet is in.</p>
        {localOnly && <p className="text-xs text-warn">This copy runs on this computer only, so an iPad cannot reach it. Pair it here in another browser to test, or once the site is online.</p>}
        <button className="btn-ghost px-0" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function TabletForm({ tablet, locations, onDone, onCancel }: { tablet?: Tablet; locations: AdminLocation[]; onDone: (t: { id: string; name: string; pairing?: Pairing }) => void; onCancel: () => void }) {
  const { loc } = useShell();
  const [name, setName] = useState(tablet?.name ?? `${loc?.name ?? 'Kitchen'} iPad`);
  const [picked, setPicked] = useState<string[]>(tablet?.locations ?? (loc ? [loc.id] : []));
  const [active, setActive] = useState(tablet?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      if (tablet) { await api.saveTablet({ id: tablet.id, name, active, locations: picked }); onDone({ id: tablet.id, name }); }
      else { const p = await api.addTablet(name, picked); onDone({ id: p.device_id!, name, pairing: p }); }
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="card space-y-3 border-accent/40">
      <label className="block"><span className="label-sm">Tablet name</span>
        <input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <div><span className="label-sm">Where it can move stock</span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {locations.filter((l) => l.active).map((l) => (
            <button key={l.id} type="button" onClick={() => toggle(l.id)}
              className={`rounded-lg border px-3 py-1.5 text-sm font-semibold ${picked.includes(l.id) ? 'border-accent bg-accent/15 text-accent' : 'border-line text-muted'}`}>{l.name}</button>
          ))}
        </div></div>
      {tablet && (
        <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Switched on {!active && <span className="font-normal text-muted">(off: signed out at once, e.g. a lost iPad)</span>}</label>
      )}
      <Msg text={err} />
      <div className="flex gap-2">
        <button className="btn-primary" disabled={busy || !name.trim() || picked.length === 0} onClick={save}>{tablet ? 'Save' : 'Add and pair'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function Tablets() {
  const { rows, err, reload } = useList<Tablet>(api.tablets);
  const locs = useList<AdminLocation>(api.allLocations);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [pairing, setPairing] = useState<{ id: string; name: string; pairing: Pairing } | null>(null);
  const [rowErr, setRowErr] = useState<string | null>(null);
  const names = Object.fromEntries((locs.rows ?? []).map((l) => [l.id, l.name]));
  const pairAgain = (t: Tablet) => api.startPairing(t.id).then((p) => setPairing({ id: t.id, name: t.name, pairing: p })).catch((e: Error) => setRowErr(e.message));

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <p className="text-sm text-muted">A tablet is signed in once by pairing. After that people tap their name and enter their PIN.</p>
        <button className="btn-primary ml-auto shrink-0" onClick={() => { setEditing('new'); setPairing(null); }}>Add tablet</button>
      </div>
      <Msg text={err ?? rowErr ?? locs.err} />
      {pairing && <PairingCard key={pairing.pairing.code} tabletId={pairing.id} name={pairing.name} pairing={pairing.pairing} onClose={() => { setPairing(null); reload(); }} onPaired={reload} />}
      {editing === 'new' && locs.rows && (
        <TabletForm locations={locs.rows} onCancel={() => setEditing(null)}
          onDone={(t) => { setEditing(null); if (t.pairing) setPairing({ id: t.id, name: t.name, pairing: t.pairing }); reload(); }} />
      )}
      {rows && rows.length === 0 && <p className="card text-muted">No tablets yet. Add one and pair it in under a minute.</p>}
      <div className="space-y-2">
        {(rows ?? []).map((t) => editing === t.id && locs.rows ? (
          <TabletForm key={t.id} tablet={t} locations={locs.rows} onCancel={() => setEditing(null)} onDone={() => { setEditing(null); reload(); }} />
        ) : (
          <div key={t.id} className={`card flex flex-wrap items-center gap-3 py-3 ${t.active ? '' : 'opacity-60'}`}>
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{t.name} {!t.active && <span className="pill bg-surface2 text-muted">Off</span>}</div>
              <div className="text-xs text-muted">{t.locations.map((id) => names[id] ?? '…').join(' · ') || 'No location'} · last scan {ago(t.last_seen)}
                {t.paired_at ? ` · paired ${ago(t.paired_at)}` : t.last_seen ? '' : ' · not paired yet'}</div>
            </div>
            {t.people_on > 0 && <span className="pill bg-info/15 text-info">{t.people_on} signed in</span>}
            {t.active && <button className="btn py-1.5 text-sm" onClick={() => pairAgain(t)}>{t.paired_at ? 'Pair another device' : 'Pair'}</button>}
            <button className="btn py-1.5 text-sm" onClick={() => setEditing(t.id)}>Edit</button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --------------------------------------------------------------- locations --

function Locations() {
  const { rows, err, reload } = useList<AdminLocation>(api.allLocations);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AdminLocation['kind']>('storage');
  const [edit, setEdit] = useState<{ id: string; name: string; kind: AdminLocation['kind'] } | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'out' | 'inc' } | null>(null);
  const run = (p: Record<string, unknown>, ok: string) => api.saveLocation(p)
    .then(() => { setMsg({ text: ok, tone: 'inc' }); setEdit(null); setName(''); reload(); })
    .catch((e: Error) => setMsg({ text: e.message, tone: 'out' }));

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1"><span className="label-sm">New location</span>
          <input className="field mt-1" value={name} placeholder="Freezer 2" onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && name.trim() && run({ name, kind }, `${name.trim()} added.`)} /></label>
        <select className="field w-auto" value={kind} onChange={(e) => setKind(e.target.value as AdminLocation['kind'])}>{KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
        <button className="btn-primary" disabled={!name.trim()} onClick={() => run({ name, kind }, `${name.trim()} added.`)}>Add</button>
      </div>
      <Msg text={err ?? (msg?.tone === 'out' ? msg.text : null)} /><Msg text={msg?.tone === 'inc' ? msg.text : null} tone="inc" />
      <div className="space-y-2">
        {(rows ?? []).map((l) => (
          <div key={l.id} className={`card flex flex-wrap items-center gap-3 py-3 ${l.active ? '' : 'opacity-60'}`}>
            {edit?.id === l.id ? (
              <>
                <input className="field min-w-40 flex-1" value={edit.name} autoFocus onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                  onKeyDown={(e) => e.key === 'Enter' && run({ id: l.id, name: edit.name, kind: edit.kind, active: l.active }, 'Saved.')} />
                <select className="field w-auto" value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as AdminLocation['kind'] })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
                <button className="btn-primary py-1.5" onClick={() => run({ id: l.id, name: edit.name, kind: edit.kind, active: l.active }, 'Saved.')}>Save</button>
                <button className="btn-ghost py-1.5" onClick={() => setEdit(null)}>Cancel</button>
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{l.name} {!l.active && <span className="pill bg-surface2 text-muted">Closed</span>}</div>
                  <div className="text-xs text-muted">{l.kind} · {l.stocked} items in stock · {l.tablets} tablet{l.tablets === 1 ? '' : 's'}</div>
                </div>
                <button className="btn py-1.5 text-sm" onClick={() => setEdit({ id: l.id, name: l.name, kind: l.kind })}>Rename</button>
                <button className="btn py-1.5 text-sm" onClick={() => run({ id: l.id, name: l.name, kind: l.kind, active: !l.active }, l.active ? `${l.name} is closed.` : `${l.name} is open again.`)}>
                  {l.active ? 'Close' : 'Reopen'}</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// -------------------------------------------------------------- categories --

function Categories() {
  const { rows, err, reload } = useList<Category>(api.categories);
  const [name, setName] = useState('');
  const [prefix, setPrefix] = useState('');
  const [touched, setTouched] = useState(false);
  const [edit, setEdit] = useState<{ original: string; name: string; prefix: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string; tone: 'out' | 'inc' } | null>(null);
  const taken = useMemo(() => new Set((rows ?? []).map((c) => c.prefix)), [rows]);
  const shownPrefix = touched ? prefix : suggestPrefix(name, taken);
  const run = (p: Record<string, unknown>, ok: string) => api.saveCategory(p)
    .then(() => { setMsg({ text: ok, tone: 'inc' }); setEdit(null); setName(''); setPrefix(''); setTouched(false); reload(); })
    .catch((e: Error) => setMsg({ text: e.message, tone: 'out' }));

  return (
    <div className="space-y-3">
      <div className="card flex flex-wrap items-end gap-2">
        <label className="min-w-48 flex-1"><span className="label-sm">New category</span>
          <input className="field mt-1" value={name} placeholder="Snacks" onChange={(e) => setName(e.target.value)} /></label>
        <label className="w-28"><span className="label-sm">SKU prefix</span>
          <input className="field mt-1 font-mono uppercase" maxLength={5} value={shownPrefix} onChange={(e) => { setTouched(true); setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, '')); }} /></label>
        <button className="btn-primary" disabled={!name.trim() || shownPrefix.length < 2} onClick={() => run({ name, prefix: shownPrefix }, `${name.trim()} added: its first SKU is ${shownPrefix}-0001.`)}>Add</button>
      </div>
      <Msg text={err ?? (msg?.tone === 'out' ? msg.text : null)} /><Msg text={msg?.tone === 'inc' ? msg.text : null} tone="inc" />
      <div className="grid gap-2 sm:grid-cols-2">
        {(rows ?? []).map((c) => (
          <div key={c.name} className={`card flex items-center gap-3 py-3 ${c.active ? '' : 'opacity-60'}`}>
            {edit?.original === c.name ? (
              <>
                <input className="field min-w-0 flex-1" value={edit.name} disabled={c.items > 0} title={c.items > 0 ? 'Items use this name, so it stays' : ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
                <input className="field w-20 font-mono uppercase" maxLength={5} value={edit.prefix} onChange={(e) => setEdit({ ...edit, prefix: e.target.value.toUpperCase().replace(/[^A-Z]/g, '') })} />
                <button className="btn-primary py-1.5" onClick={() => run({ original: c.name, name: edit.name, prefix: edit.prefix, active: c.active }, 'Saved.')}>Save</button>
              </>
            ) : (
              <>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold">{c.name} <span className="font-mono text-xs text-muted">{c.prefix}</span></div>
                  <div className="text-xs text-muted">{c.items} items · next {c.next_sku}</div>
                </div>
                <button className="btn py-1.5 text-sm" onClick={() => setEdit({ original: c.name, name: c.name, prefix: c.prefix })}>Edit</button>
                <button className="btn py-1.5 text-sm" onClick={() => run({ original: c.name, name: c.name, prefix: c.prefix, active: !c.active }, c.active ? `${c.name} is switched off.` : `${c.name} is back on.`)}>
                  {c.active ? 'Off' : 'On'}</button>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ screen --

function AdminScreen() {
  const { who } = useShell();
  const role = who.manager?.role;
  const tabs = ([['people', 'People'], ['tablets', 'Tablets'], ['locations', 'Locations'], ['categories', 'Categories']] as [Tab, string][])
    .filter(([t]) => (t === 'people' || t === 'tablets' ? can(role, 'people') : can(role, 'items_edit')));
  const [tab, setTab] = useState<Tab>(tabs[0]?.[0] ?? 'locations');
  useEffect(() => { try { const s = localStorage.getItem('hk.admintab') as Tab | null; if (s && tabs.some(([t]) => t === s)) setTab(s); } catch { /* fine */ } }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const pick = (t: Tab) => { setTab(t); try { localStorage.setItem('hk.admintab', t); } catch { /* fine */ } };

  if (!who.manager) return <div className="card">Admin is for managers. Sign in with your email on a computer or phone.</div>;
  if (isPreview()) return <div className="card">Admin needs a database. Run <code>npm run local:db</code> and <code>npm run dev:local</code>.</div>;
  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto rounded-xl bg-surface2 p-1">
        {tabs.map(([t, l]) => (
          <button key={t} onClick={() => pick(t)} className={`flex-1 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold ${tab === t ? 'bg-surface shadow-sm' : 'text-muted'}`}>{l}</button>
        ))}
      </div>
      {tab === 'people' && <People />}
      {tab === 'tablets' && <Tablets />}
      {tab === 'locations' && <Locations />}
      {tab === 'categories' && <Categories />}
    </div>
  );
}

export default function AdminPage() {
  return <Shell><AdminScreen /></Shell>;
}
