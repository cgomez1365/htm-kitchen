'use client';
/**
 * Items & stock for catalogues of thousands: searched, filtered and paged by the
 * database (item_search), 50 at a time (FQC trap: PostgREST stops at 1,000 rows).
 * Shows stock here and across all locations. Managers add items and barcodes; the
 * label (QR + Code 128) is drawn in the browser and printed from it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import Shell, { useShell } from '@/components/Shell';
import { api } from '@/lib/api';
import { can } from '@/lib/roles';
import { num, type FeedRow, type Item, type ItemDetail } from '@/lib/types';

const PAGE = 50;
const STATES: [string, string][] = [['active', 'Active'], ['attention', 'Low or out'], ['out', 'Out'], ['inactive', 'Inactive'], ['all', 'All']];
const CATS = ['Dry Goods', 'Produce', 'Proteins', 'Dairy', 'Frozen', 'Beverages', 'Bakery', 'Cleaning', 'Paper & Disposables', 'Equipment', 'Donation', 'Other'];
const UNITS = ['units', 'pcs', 'lbs', 'oz', 'kg', 'gallons', 'liters', 'cases', 'boxes', 'bags', 'dozens', 'cans', 'trays', 'packs'];
const fmt = (v: unknown) => num(v).toLocaleString(undefined, { maximumFractionDigits: 3 });
const money = (v: unknown) => '$' + num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const state = (it: Item): [string, string] => {
  if (!it.active) return ['bg-surface2 text-muted', 'Inactive'];
  if (num(it.on_hand) <= 0) return ['bg-out/15 text-out', 'Out'];
  if (num(it.min_level) > 0 && num(it.on_hand) <= num(it.min_level)) return ['bg-warn/15 text-warn', 'Low'];
  return ['bg-inc/15 text-inc', 'OK'];
};

function ItemsScreen() {
  const { who, loc } = useShell();
  const manager = who.manager;
  const [q, setQ] = useState('');
  const [st, setSt] = useState('active');
  const [cat, setCat] = useState('');
  const [here, setHere] = useState(false);
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ rows: Item[]; total: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    if (!loc) return;
    api.search({ q, state: st, category: cat || null, location_id: loc.id, only_here: here, offset, limit: PAGE })
      .then((d) => { setData(d); setErr(null); })
      .catch((e: Error) => setErr(e.message)); // R-10: a failed read is said, never shown as an empty list
  }, [q, st, cat, here, offset, loc]);
  useEffect(() => { const t = setTimeout(load, q ? 250 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div><h1 className="text-2xl font-bold">Items & stock</h1><p className="text-sm text-muted">{data ? `${data.total.toLocaleString()} SKUs match` : ' '}</p></div>
        {can(manager?.role, 'items_edit') && <button className="btn-primary" onClick={() => setCreating(true)}>New item</button>}
      </div>
      <div className="mb-3 flex flex-wrap gap-2">
        <input className="field max-w-xs" placeholder="Search name, SKU, barcode, supplier" value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
        <select className="field w-auto" value={cat} onChange={(e) => { setCat(e.target.value); setOffset(0); }}>
          <option value="">All categories</option>{CATS.map((c) => <option key={c}>{c}</option>)}</select>
        <div className="flex gap-1 rounded-xl bg-surface2 p-1">{STATES.map(([k, l]) => (
          <button key={k} onClick={() => { setSt(k); setOffset(0); }} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${st === k ? 'bg-surface shadow-sm' : 'text-muted'}`}>{l}</button>))}</div>
        <label className="flex items-center gap-2 text-sm font-semibold text-muted"><input type="checkbox" checked={here} onChange={(e) => { setHere(e.target.checked); setOffset(0); }} /> Only stocked here</label>
      </div>
      {err && <div className="card mb-3 border-out/40 font-semibold text-out">Could not load items: {err}</div>}
      <div className="card overflow-x-auto p-2">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className="p-2">Item</th><th className="p-2">SKU</th><th className="hidden p-2 md:table-cell">Category</th>
            <th className="p-2 text-right">Here</th><th className="p-2 text-right">All</th><th className="hidden p-2 text-right sm:table-cell">Min</th><th className="p-2" /></tr></thead>
          <tbody>
            {(data?.rows ?? []).map((it) => { const [c, l] = state(it); return (
              <tr key={it.id} className="cursor-pointer border-t border-line hover:bg-surface2" onClick={() => setOpen(it.id)}>
                <td className="p-2"><div className="font-semibold">{it.name}</div><div className="text-xs text-muted">{it.spot ?? ''}</div></td>
                <td className="p-2 font-mono">{it.sku}</td><td className="hidden p-2 text-muted md:table-cell">{it.category}</td>
                <td className="p-2 text-right font-bold tnum">{fmt(it.here)}</td><td className="p-2 text-right tnum">{fmt(it.on_hand)} <span className="text-muted">{it.unit}</span></td>
                <td className="hidden p-2 text-right text-muted tnum sm:table-cell">{fmt(it.min_level)}</td>
                <td className="p-2 text-right"><span className={`pill ${c}`}>{l}</span></td>
              </tr>); })}
          </tbody>
        </table>
        {data && !data.rows.length && <p className="p-6 text-center text-muted">{data.total === 0 && !q ? 'No items yet.' : 'No items match.'}</p>}
        {data && data.total > PAGE && (
          <div className="flex items-center justify-between p-2 text-sm text-muted">
            <span>{offset + 1}–{offset + data.rows.length} of {data.total.toLocaleString()}</span>
            <div className="flex gap-2"><button className="btn" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Previous</button>
              <button className="btn" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>Next</button></div>
          </div>
        )}
      </div>
      {open && <ItemDrawer id={open} onClose={() => { setOpen(null); load(); }} canEdit={can(manager?.role, 'items_edit')} />}
      {creating && <NewItem locationId={loc?.id ?? null} onClose={(id) => { setCreating(false); load(); if (id) setOpen(id); }} />}
    </div>
  );
}

function Label({ item }: { item: Item }) {
  const [qr, setQr] = useState('');
  const bar = useRef<SVGSVGElement>(null);
  useEffect(() => {
    // The label carries HK1:<SKU>, never a web address, so moving domains never means reprinting (FQC trap).
    QRCode.toDataURL(`HK1:${item.sku}`, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(''));
    if (bar.current) JsBarcode(bar.current, `HK1:${item.sku}`, { format: 'CODE128', displayValue: false, height: 40, margin: 0, width: 1.6 });
  }, [item.sku]);
  return (
    <div className="hk-label mx-auto grid w-[330px] grid-cols-[auto_1fr] gap-x-3 rounded-lg border border-dashed border-[#bbb] bg-white p-3 text-[#111]">
      {qr && <img src={qr} alt="" className="row-span-3 h-[92px] w-[92px]" style={{ imageRendering: 'pixelated' }} />}
      <div className="text-[15px] font-extrabold leading-tight">{item.name}</div>
      <div className="font-mono text-[13px] font-bold">{item.sku}</div>
      <div className="text-[11px] text-[#555]">{item.unit}{item.spot ? ` · ${item.spot}` : ''}</div>
      <svg ref={bar} className="col-span-2 mt-1 h-[34px] w-full" preserveAspectRatio="none" />
      <div className="col-span-2 flex justify-between text-[9px] uppercase tracking-widest text-[#777]"><span>Hope the Mission · Kitchen</span><span>{item.category}</span></div>
    </div>
  );
}

function ItemDrawer({ id, onClose, canEdit }: { id: string; onClose: () => void; canEdit: boolean }) {
  const [it, setIt] = useState<ItemDetail | null>(null);
  const [feed, setFeed] = useState<FeedRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState(''), [pack, setPack] = useState('1');
  const load = useCallback(() => {
    api.detail(id).then(setIt).catch((e: Error) => setErr(e.message));
    api.feed(null, id, 15).then(setFeed).catch(() => {});
  }, [id]);
  useEffect(load, [load]);
  const addCode = async () => {
    try { await api.addCode(id, code.trim(), Number(pack) || 1, Number(pack) > 1 ? `Case of ${pack}` : 'Maker barcode'); setCode(''); setPack('1'); load(); }
    catch (e) { setErr((e as Error).message); }
  };
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-bg p-5">
        <div className="flex justify-between"><span /><button className="btn-ghost" onClick={onClose}>Close</button></div>
        {err && <p className="font-semibold text-out">{err}</p>}
        {it && <>
          <h2 className="text-2xl font-bold">{it.name}</h2><p className="font-mono text-muted">{it.sku} · {it.category}</p>
          <div className="my-4 grid grid-cols-3 gap-2">
            <div className="card"><div className="label-sm">All locations</div><div className="text-2xl font-bold tnum">{fmt(it.on_hand)}</div><div className="text-xs text-muted">{it.unit}</div></div>
            <div className="card"><div className="label-sm">Pulled 30 days</div><div className="text-2xl font-bold tnum">{fmt(it.pulled_30)}</div></div>
            <div className="card"><div className="label-sm">Value</div><div className="text-xl font-bold tnum">{money(Math.max(0, num(it.on_hand)) * num(it.price))}</div></div>
          </div>
          <div className="card mb-4 p-2"><table className="w-full text-sm"><tbody>
            {it.levels.map((l) => <tr key={l.id} className="border-b border-line last:border-0"><td className="p-2">{l.name}</td><td className="p-2 text-right font-bold tnum">{fmt(l.on_hand)} {it.unit}</td></tr>)}
          </tbody></table></div>
          <div className="rounded-2xl bg-surface2 p-4"><Label item={it} /></div>
          <button className="btn mt-3" onClick={() => window.print()}>Print label</button>
          <h3 className="mb-2 mt-5 font-bold">Barcodes that scan as this item</h3>
          <div className="space-y-1 text-sm">
            <div className="flex justify-between"><span className="font-mono">HK1:{it.sku}</span><span className="text-muted">our label · 1 {it.unit}</span></div>
            {it.code_list.map((c) => <div key={c.code} className={`flex justify-between ${c.active ? '' : 'opacity-50'}`}><span className="font-mono">{c.code}</span><span className="text-muted">{c.label} · {fmt(c.pack_qty)} {it.unit}</span></div>)}
          </div>
          {canEdit && <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); void addCode(); }}>
            <input className="field font-mono" placeholder="Scan or type a maker barcode" value={code} onChange={(e) => setCode(e.target.value)} />
            <input className="field w-20" inputMode="decimal" title="How many units one scan counts" value={pack} onChange={(e) => setPack(e.target.value)} />
            <button className="btn" disabled={!code.trim()}>Add</button></form>}
          <h3 className="mb-2 mt-5 font-bold">Recent movements</h3>
          {feed.map((m) => <div key={m.id} className="flex justify-between border-b border-line py-1.5 text-sm"><span>{m.person_name} · {m.location_name}</span>
            <span className={`tnum font-bold ${num(m.qty) < 0 ? 'text-out' : 'text-inc'}`}>{num(m.qty) > 0 ? '+' : ''}{fmt(m.qty)}</span></div>)}
          {!feed.length && <p className="text-sm text-muted">No movements yet.</p>}
        </>}
      </div>
    </div>
  );
}

function NewItem({ locationId, onClose }: { locationId: string | null; onClose: (id?: string) => void }) {
  const [f, setF] = useState<Record<string, string>>({ name: '', category: 'Dry Goods', unit: 'units', sku: '', opening: '', min_level: '', par_level: '', price: '', supplier: '', spot: '', barcode: '' });
  const [err, setErr] = useState<string | null>(null);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  useEffect(() => { api.nextSku(f.category).then((s) => setF((x) => ({ ...x, sku: s ?? '' }))).catch(() => {}); }, [f.category]);
  const save = async () => {
    try { const id = await api.saveItem({ ...f, location_id: locationId }); onClose(id); } catch (e) { setErr((e as Error).message); }
  };
  const field = (k: string, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block"><span className="label-sm">{label}</span><input className="field mt-1" value={f[k]} onChange={set(k)} {...props} /></label>);
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/40" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="h-full w-full max-w-lg space-y-3 overflow-y-auto bg-bg p-5" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="flex justify-between"><h2 className="text-2xl font-bold">New item</h2><button type="button" className="btn-ghost" onClick={() => onClose()}>Close</button></div>
        <p className="text-sm text-muted">A SKU and a printable QR + barcode label are made for every new item.</p>
        {field('name', 'Name', { required: true })}
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="label-sm">Category</span><select className="field mt-1" value={f.category} onChange={set('category')}>{CATS.map((c) => <option key={c}>{c}</option>)}</select></label>
          <label className="block"><span className="label-sm">Unit</span><select className="field mt-1" value={f.unit} onChange={set('unit')}>{UNITS.map((u) => <option key={u}>{u}</option>)}</select></label>
        </div>
        <div className="grid grid-cols-2 gap-3">{field('sku', 'SKU (made for you)')}{field('opening', 'Opening count here', { inputMode: 'decimal' })}</div>
        <div className="grid grid-cols-3 gap-3">{field('min_level', 'Minimum', { inputMode: 'decimal' })}{field('par_level', 'Par', { inputMode: 'decimal' })}{field('price', 'Price / unit', { inputMode: 'decimal' })}</div>
        <div className="grid grid-cols-2 gap-3">{field('spot', 'Storage spot')}{field('supplier', 'Supplier')}</div>
        {field('barcode', 'Maker barcode (optional)')}
        {err && <p className="font-semibold text-out">{err}</p>}
        <button className="btn-primary w-full">Create item & label</button>
      </form>
    </div>
  );
}

export default function ItemsPage() {
  return <Shell><ItemsScreen /></Shell>;
}
