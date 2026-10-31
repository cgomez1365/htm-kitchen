'use client';
/**
 * The scan station, phone and iPad first. A tablet asks who is scanning (name + PIN);
 * a manager scans as themselves. Pick IN / OUT / RETURN / MOVE / COUNT, then scan a label
 * with the camera, a USB/Bluetooth scanner (it types the code and presses Return), or type it.
 *
 * Every scan goes through the offline queue: it is saved on the device first, then sent.
 * The answer shown is the database's - a refusal is shown word for word, never guessed.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import Shell, { useShell } from '@/components/Shell';
import PinGate from '@/components/PinGate';
import CameraScanner from '@/components/CameraScanner';
import { api, NetworkError } from '@/lib/api';
import { loadActor, saveActor, touchActor } from '@/lib/actor';
import { dismiss, newId, onQueueChange, pending, submit, type Queued } from '@/lib/offline';
import { can, ROLE_NAMES, type Role } from '@/lib/roles';
import { num, type Actor, type DoorResult, type FeedRow, type Item, type ScanKind } from '@/lib/types';

const OUT_REASONS = ['Kitchen use', 'Meal service', 'To a site', 'Event', 'Donation out', 'Staff meal'];
const KIND_LABEL: Record<string, string> = { receive: 'In', issue: 'Out', return: 'Return', transfer: 'Move', count: 'Count', undo: 'Undo', loss: 'Loss', adjust: 'Adjust' };
const fmt = (v: unknown) => num(v).toLocaleString(undefined, { maximumFractionDigits: 3 });

// Items seen on this device, so a scan in a walk-in with no signal still knows what it scanned.
const CACHE = 'hk.codecache';
function remember(code: string, item: Item, pack: number) {
  try {
    const m = JSON.parse(localStorage.getItem(CACHE) ?? '{}');
    m[code.toUpperCase()] = { item, pack, at: Date.now() };
    const keys = Object.keys(m);
    if (keys.length > 3000) keys.sort((a, b) => m[a].at - m[b].at).slice(0, keys.length - 3000).forEach((k) => delete m[k]);
    localStorage.setItem(CACHE, JSON.stringify(m));
  } catch { /* storage full or off: online lookups still work */ }
}
function recall(code: string): { item: Item; pack: number } | null {
  try { return JSON.parse(localStorage.getItem(CACHE) ?? '{}')[code.toUpperCase().replace(/^HK1:/, '')] ?? null; } catch { return null; }
}

type Result =
  | { state: 'ok'; kind: ScanKind; item: Item; qty: number; pack: number; r: DoorResult; scanId: string }
  | { state: 'queued'; kind: ScanKind; item: Item; qty: number }
  | { state: 'refused'; item?: Item; reason: string }
  | { state: 'unknown'; code: string; retired?: boolean }
  | { state: 'counting'; item: Item };

function ScanScreen() {
  const { who, loc } = useShell();
  const [actor, setActor] = useState<Actor | null>(null);
  const [ready, setReady] = useState(false);
  const role: Role | null = who.manager?.role ?? actor?.role ?? null;
  const token = who.manager ? null : actor?.token ?? null;
  const [mode, setMode] = useState<ScanKind>('issue');
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(OUT_REASONS[0]);
  const [to, setTo] = useState<string>('');
  const [camera, setCamera] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [queue, setQueue] = useState<Queued[]>([]);
  const [counted, setCounted] = useState('');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setActor(who.device ? loadActor() : null); setReady(true); }, [who.device]);
  // The screen locks itself after 10 minutes without a touch (the token lives on for queued scans).
  useEffect(() => {
    if (!who.device) return;
    const t = setInterval(() => { if (!loadActor()) setActor(null); }, 15_000);
    const touch = () => touchActor();
    window.addEventListener('pointerdown', touch); window.addEventListener('keydown', touch);
    return () => { clearInterval(t); window.removeEventListener('pointerdown', touch); window.removeEventListener('keydown', touch); };
  }, [who.device]);
  const refreshFeed = useCallback(() => { if (loc) api.feed(loc.id).then(setFeed).catch(() => {}); }, [loc]);
  useEffect(() => { refreshFeed(); }, [refreshFeed]);
  useEffect(() => { const r = () => pending().then(setQueue); r(); return onQueueChange(r) as () => void; }, []);
  useEffect(() => {
    const other = who.locations.find((l) => l.id !== loc?.id);
    if (!to || to === loc?.id) setTo(other?.id ?? '');
  }, [loc, who.locations, to]);
  useEffect(() => { if (!can(role, mode === 'count' ? 'adjust' : mode === 'receive' ? 'receive' : 'issue')) setMode('issue'); }, [role, mode]);

  const onScan = useCallback(async (raw: string) => {
    const code = raw.trim();
    if (!code || !loc) return;
    let item: Item | undefined, pack = 1;
    try {
      const r = await api.lookup(code, loc.id);
      if (!r.found) return setResult({ state: 'unknown', code: r.code ?? code, retired: r.retired });
      item = r.item!; pack = num(r.packQty) || 1;
      remember(code.replace(/^HK1:/i, ''), item, pack);
    } catch (e) {
      if (!(e instanceof NetworkError)) return setResult({ state: 'refused', reason: (e as Error).message });
      const c = recall(code);
      if (!c) return setResult({ state: 'refused', reason: 'No signal, and this label has not been scanned on this tablet before. Scan it again when the signal is back.' });
      item = c.item; pack = c.pack;
    }
    if (mode === 'count') { setCounted(''); return setResult({ state: 'counting', item }); }
    const amount = qty * pack, at = new Date().toISOString(), id = newId();
    const label = `${KIND_LABEL[mode]} ${fmt(amount)} ${item.unit} ${item.name}`;
    let r: DoorResult | null;
    try {
      r = mode === 'transfer'
        ? await submit('transfer', { id, idIn: newId(), token, at, item: item.id, from: loc.id, to, qty: amount }, label)
        : await submit('move', { id, token, at, item: item.id, location: loc.id, kind: mode, qty: amount, reason: mode === 'issue' ? reason : null }, label);
    } catch (e) { return setResult({ state: 'refused', item, reason: (e as Error).message }); }
    setQty(1);
    if (r === null) return setResult({ state: 'queued', kind: mode, item, qty: amount });
    if (r.refused) return setResult({ state: 'refused', item, reason: r.reason ?? 'Refused.' });
    setResult({ state: 'ok', kind: mode, item, qty: amount, pack, r, scanId: id });
    refreshFeed();
  }, [loc, mode, qty, reason, to, token, refreshFeed]);

  const saveCount = async (item: Item) => {
    if (!loc || counted === '') return;
    const r = await submit('count', { id: newId(), token, at: new Date().toISOString(), item: item.id, location: loc.id, counted: Number(counted) }, `Count ${item.name}`).catch((e: Error) => ({ refused: true, reason: e.message }) as DoorResult);
    if (r === null) setResult({ state: 'queued', kind: 'count', item, qty: Number(counted) });
    else if (r.refused) setResult({ state: 'refused', item, reason: r.reason ?? 'Refused.' });
    else { setResult(null); refreshFeed(); }
  };
  const undo = async (target: string) => {
    const r = await submit('undo', { id: newId(), token, at: new Date().toISOString(), target }, 'Undo').catch((e: Error) => ({ refused: true, reason: e.message }) as DoorResult);
    if (r && r.refused) setResult({ state: 'refused', reason: r.reason ?? 'Refused.' });
    else { setResult(null); refreshFeed(); }
  };
  const lock = async () => { if (actor) await api.signOut(actor.token).catch(() => false); saveActor(null); setActor(null); setResult(null); };

  if (!ready || !loc) return null;
  if (who.device && !actor) return <PinGate onIn={setActor} />;

  const modes: [ScanKind, string, string, boolean][] = [
    ['receive', 'IN', 'Delivery', can(role, 'receive')], ['issue', 'OUT', 'Pull for use', can(role, 'issue')],
    ['return', 'RETURN', 'Back to shelf', can(role, 'issue')], ['transfer', 'MOVE', 'Other location', can(role, 'issue') && who.locations.length > 1],
    ['count', 'COUNT', 'Shelf count', can(role, 'adjust')],
  ];
  const tone: Record<string, string> = { receive: 'border-inc bg-inc/10 text-inc', issue: 'border-out bg-out/10 text-out', return: 'border-info bg-info/10 text-info', transfer: 'border-accent bg-accent/10 text-accent', count: 'border-warn bg-warn/10 text-warn' };

  return (
    <div className="grid gap-5 lg:grid-cols-[1.3fr_1fr]">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div><h1 className="text-2xl font-bold">Scan</h1>
            <p className="text-sm text-muted">At <b>{loc.name}</b> as <b>{who.manager?.display_name ?? actor?.name}</b> ({role ? ROLE_NAMES[role] : ''}). Every scan is saved with that name.</p></div>
          {actor && <button className="btn" onClick={lock}>Lock</button>}
        </div>

        {queue.filter((q) => q.status === 'refused').map((q) => (
          <div key={q.id} className="card flex items-start justify-between gap-3 border-out/40 bg-out/5">
            <div><div className="font-semibold">Not recorded: {q.label}</div><div className="text-sm text-out">{q.reason}</div></div>
            <button className="btn-ghost" onClick={() => dismiss(q.id)}>OK</button>
          </div>
        ))}

        <div className="grid grid-cols-5 gap-2">
          {modes.map(([m, label, sub, ok]) => (
            <button key={m} disabled={!ok} onClick={() => { setMode(m); setResult(null); }}
              className={`rounded-2xl border-2 px-0.5 py-3 text-center text-[13px] font-bold disabled:opacity-30 sm:text-base ${mode === m ? tone[m] : 'border-line bg-surface'}`}>
              {label}<div className="hidden text-[11px] font-medium opacity-80 sm:block">{sub}</div>
            </button>
          ))}
        </div>

        <div className="card space-y-3">
          {mode !== 'count' && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="label-sm">Quantity per scan</span>
              <div className="flex items-center overflow-hidden rounded-xl border border-line">
                <button className="h-11 w-11 bg-surface2 text-xl" onClick={() => setQty((q) => Math.max(1, q - 1))}>−</button>
                <input className="h-11 w-16 bg-surface text-center text-lg font-bold tnum outline-none" inputMode="decimal" value={qty}
                  onChange={(e) => setQty(Math.max(0, Number(e.target.value) || 0))} />
                <button className="h-11 w-11 bg-surface2 text-xl" onClick={() => setQty((q) => q + 1)}>+</button>
              </div>
              {mode === 'issue' && <select className="field w-auto" value={reason} onChange={(e) => setReason(e.target.value)}>{OUT_REASONS.map((r) => <option key={r}>{r}</option>)}</select>}
              {mode === 'transfer' && <select className="field w-auto" value={to} onChange={(e) => setTo(e.target.value)}>
                {who.locations.filter((l) => l.id !== loc.id).map((l) => <option key={l.id} value={l.id}>to {l.name}</option>)}</select>}
            </div>
          )}
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); const v = input.current!.value; input.current!.value = ''; void onScan(v); }}>
            <input ref={input} autoFocus className="field font-mono text-lg" placeholder="Scan a label, or type a SKU" autoComplete="off" spellCheck={false} />
            <button className="btn-primary">Enter</button>
          </form>
          {camera ? <CameraScanner onCode={onScan} onClose={() => setCamera(false)} />
            : <button className="btn w-full" onClick={() => setCamera(true)}>Use the camera</button>}
        </div>

        <ResultCard result={result} counted={counted} setCounted={setCounted} saveCount={saveCount} undo={undo} locName={loc.name} />
      </div>

      <div className="card h-fit">
        <div className="mb-3 flex items-center justify-between"><h2 className="font-bold">Recent at {loc.name}</h2>
          {queue.some((q) => q.status === 'waiting') && <span className="pill bg-warn/15 text-warn">{queue.filter((q) => q.status === 'waiting').length} waiting</span>}</div>
        <div className="space-y-2">
          {queue.filter((q) => q.status === 'waiting').map((q) => (
            <div key={q.id} className="flex items-center justify-between rounded-xl border border-dashed border-warn/50 px-3 py-2 text-sm">
              <span>{q.label}</span><span className="text-warn">waiting for signal</span></div>
          ))}
          {feed.map((m) => (
            <div key={m.id} className={`flex items-center gap-3 rounded-xl border border-line px-3 py-2 ${m.undone ? 'opacity-50 line-through' : ''}`}>
              <span className="pill bg-surface2">{KIND_LABEL[m.kind] ?? m.kind}</span>
              <div className="min-w-0 flex-1"><div className="truncate font-semibold">{m.item_name}</div>
                <div className="text-xs text-muted">{m.person_name} · {new Date(m.happened_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></div>
              <span className={`tnum font-bold ${num(m.qty) < 0 ? 'text-out' : 'text-inc'}`}>{num(m.qty) > 0 ? '+' : ''}{fmt(m.qty)}</span>
            </div>
          ))}
          {!feed.length && !queue.some((q) => q.status === 'waiting') && <p className="py-6 text-center text-muted">No scans here yet.</p>}
        </div>
      </div>
    </div>
  );
}

function ResultCard({ result, counted, setCounted, saveCount, undo, locName }: {
  result: Result | null; counted: string; setCounted: (v: string) => void; saveCount: (i: Item) => void; undo: (id: string) => void; locName: string;
}) {
  if (!result) return <div className="card text-muted">Waiting for a scan…</div>;
  if (result.state === 'unknown') return (
    <div className="card border-warn/50 bg-warn/5"><h2 className="text-lg font-bold">{result.retired ? 'Retired barcode' : 'Unknown code'}</h2>
      <p className="font-mono">{result.code}</p>
      <p className="mt-1 text-sm text-muted">{result.retired ? 'This barcode was taken off its item. Scan the shelf label instead.' : 'An Inventory Manager can add it to an item from Items.'}</p></div>);
  if (result.state === 'refused') return (
    <div className="card border-out/50 bg-out/5"><h2 className="text-lg font-bold">Not recorded{result.item ? `: ${result.item.name}` : ''}</h2>
      <p className="font-semibold text-out">{result.reason}</p></div>);
  if (result.state === 'queued') return (
    <div className="card border-warn/50 bg-warn/5"><h2 className="text-lg font-bold">Saved on this tablet</h2>
      <p>{KIND_LABEL[result.kind]} {fmt(result.qty)} {result.item.unit} {result.item.name}. No signal right now; it sends on its own when the signal is back.</p></div>);
  if (result.state === 'counting') return (
    <div className="card border-warn/50 bg-warn/5"><h2 className="text-lg font-bold">{result.item.name}</h2>
      <p className="font-mono text-sm text-muted">{result.item.sku}</p>
      <form className="mt-3 flex gap-2" onSubmit={(e) => { e.preventDefault(); saveCount(result.item); }}>
        <input className="field tnum text-lg" inputMode="decimal" autoFocus placeholder={`What is on the shelf at ${locName}?`} value={counted} onChange={(e) => setCounted(e.target.value)} />
        <button className="btn-primary">Save count</button>
      </form></div>);
  const { kind, item, qty, pack, r, scanId } = result;
  const tone = kind === 'issue' || kind === 'transfer' ? 'border-out/50 bg-out/5' : kind === 'receive' ? 'border-inc/50 bg-inc/5' : 'border-info/50 bg-info/5';
  return (
    <div className={`card ${tone}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <span className="pill bg-surface2">{KIND_LABEL[kind]} {kind === 'issue' || kind === 'transfer' ? '−' : '+'}{fmt(qty)} {item.unit}</span>
          {pack > 1 && <span className="pill ml-1 bg-surface2">pack of {fmt(pack)}</span>}
          {r.duplicate && <span className="pill ml-1 bg-surface2">already recorded</span>}
          <h2 className="mt-2 text-2xl font-bold">{item.name}</h2>
          <p className="font-mono text-sm text-muted">{item.sku}{item.spot ? ` · ${item.spot}` : ''}</p>
          {r.flag && <p className="mt-1 text-sm font-semibold text-warn">{r.flag}</p>}
        </div>
        <div className="text-right"><div className="label-sm">Here now</div><div className="text-5xl font-bold tnum">{fmt(r.here)}</div>
          <div className="text-sm text-muted">{item.unit} · {fmt(r.total)} in all</div></div>
      </div>
      <button className="btn mt-3" onClick={() => undo(scanId)}>Undo this scan</button>
    </div>
  );
}

export default function ScanPage() {
  return <Shell><ScanScreen /></Shell>;
}

