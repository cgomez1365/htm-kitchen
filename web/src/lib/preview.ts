/**
 * Preview mode (NEXT_PUBLIC_HK_PREVIEW=1): every screen with invented data and no sign-in,
 * the FQC way to look at a page without credentials. It plays a kitchen tablet with a chef
 * unlocked. It follows the doors' answers closely enough to see a screen work; it is NOT
 * the rules - those are in SQL and proven by tools/test-sql.mjs.
 */
import type { Item } from './types';

const MAIN = 'loc-main', WALK = 'loc-walk';
const cats = ['Dry Goods', 'Produce', 'Proteins', 'Dairy', 'Cleaning'];
const names: Record<string, string[]> = {
  'Dry Goods': ['Kosher Salt', 'Olive Oil', 'Long-grain Rice 25 lb', 'All-purpose Flour', 'Black Beans #10', 'Spaghetti'],
  Produce: ['Roma Tomatoes', 'Yellow Onions', 'Russet Potatoes', 'Carrots', 'Romaine'],
  Proteins: ['Chicken Thighs', 'Ground Beef 80/20', 'Eggs (15 dz)'],
  Dairy: ['Whole Milk', 'Shredded Cheddar', 'Butter'],
  Cleaning: ['Nitrile Gloves L', 'Sanitizer Tablets', 'Trash Liners 55 gal'],
};
const prefix: Record<string, string> = { 'Dry Goods': 'DRY', Produce: 'PRD', Proteins: 'PRO', Dairy: 'DAI', Cleaning: 'CLN' };
let n = 0;
const items: (Item & { levels: Record<string, number> })[] = cats.flatMap((c) => names[c].map((nm, i) => {
  n++;
  const here = (n * 7) % 40, walk = c === 'Proteins' || c === 'Dairy' ? (n * 3) % 30 : 0;
  return { id: `item-${n}`, sku: `${prefix[c]}-${String(i + 1).padStart(4, '0')}`, name: nm, category: c,
    unit: c === 'Produce' || c === 'Proteins' ? 'lbs' : 'cases', min_level: 10 + (n % 8), par_level: 30, price: 1 + (n % 12) * 1.5,
    supplier: ['Sysco', 'Restaurant Depot', 'Local farm'][n % 3], spot: `Shelf ${1 + (n % 9)}`, active: true,
    on_hand: here + walk, last_moved: new Date(Date.now() - n * 3600e3).toISOString(), codes: n === 3 ? '10012345000017' : null,
    levels: { [MAIN]: here, [WALK]: walk } };
}));
const feed: Record<string, unknown>[] = [];
const total = (it: (typeof items)[number]) => Object.values(it.levels).reduce((a, b) => a + b, 0);
const view = (it: (typeof items)[number], loc?: unknown) => ({ ...it, on_hand: total(it), here: loc ? it.levels[String(loc)] ?? 0 : null });

export async function preview(fn: string, a: Record<string, unknown>): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  const p = (a.p ?? {}) as Record<string, unknown>;
  switch (fn) {
    case 'whoami': return { manager: null, device: { id: 'dev-1', name: 'Kitchen iPad (preview)' }, setup_needed: false,
      locations: [{ id: MAIN, name: 'Main kitchen', kind: 'kitchen' }, { id: WALK, name: 'Walk-in cooler', kind: 'storage' }] };
    case 'tablet_roster': return [
      { id: 'st-1', display_name: 'James Carter', role: 'chef', has_pin: true },
      { id: 'st-2', display_name: 'Ana Ruiz', role: 'staff', has_pin: true },
      { id: 'st-3', display_name: 'Ivy Inventory', role: 'inventory', has_pin: true }];
    case 'tablet_sign_in': return a.p_pin === '1357' || a.p_pin === '1234'
      ? [{ token: 'preview-token-'.padEnd(48, 'x'), expires_at: new Date(Date.now() + 12 * 3600e3).toISOString(), display_name: 'James Carter', role: 'chef', refused: false, locked: false, reason: null }]
      : [{ token: null, refused: true, locked: false, reason: 'Wrong PIN. (Preview PIN is 1357.)' }];
    case 'tablet_sign_out': return true;
    case 'item_search': {
      const q = String(p.q ?? '').toLowerCase(), st = String(p.state ?? 'active'), loc = p.location_id;
      let rows = items.filter((it) => !q || `${it.name} ${it.sku} ${it.supplier}`.toLowerCase().includes(q))
        .filter((it) => !p.category || it.category === p.category);
      if (st === 'attention') rows = rows.filter((it) => total(it) <= Number(it.min_level));
      if (p.only_here) rows = rows.filter((it) => (it.levels[String(loc)] ?? 0) !== 0);
      const off = Number(p.offset ?? 0), lim = Number(p.limit ?? 50);
      return { rows: rows.slice(off, off + lim).map((it) => view(it, loc)), total: rows.length, offset: off, limit: lim };
    }
    case 'lookup_code': {
      const c = String(a.p_code ?? '').replace(/^HK1:/i, '').toUpperCase();
      const it = items.find((i) => i.sku === c) ?? items.find((i) => i.codes === c);
      return it ? { found: true, item: view(it, a.p_location), packQty: it.codes === c ? 24 : 1, packLabel: it.codes === c ? 'Case of 24' : null } : { found: false, code: c };
    }
    case 'item_detail': {
      const it = items.find((i) => i.id === a.p_item)!;
      return { ...view(it), levels: [{ id: MAIN, name: 'Main kitchen', kind: 'kitchen', on_hand: it.levels[MAIN], last_at: it.last_moved },
        { id: WALK, name: 'Walk-in cooler', kind: 'storage', on_hand: it.levels[WALK], last_at: null }],
        code_list: it.codes ? [{ code: it.codes, pack_qty: 24, label: 'Case of 24', active: true }] : [], pulled_30: 40 };
    }
    case 'movement_feed': return feed.slice(0, Number(a.p_limit ?? 30));
    case 'record_move': case 'record_transfer': case 'record_count': {
      const it = items.find((i) => i.id === a.p_item)!;
      const loc = String(a.p_location ?? a.p_from), qty = Number(a.p_qty ?? 0);
      const delta = fn === 'record_count' ? Number(a.p_counted) - (it.levels[loc] ?? 0) : a.p_kind === 'issue' || fn === 'record_transfer' ? -qty : qty;
      if (delta < 0 && (it.levels[loc] ?? 0) + delta < 0) return [{ id: null, refused: true, reason: `Only ${it.levels[loc] ?? 0} on hand, so ${-delta} can't come out. Count the shelf first.` }];
      it.levels[loc] = (it.levels[loc] ?? 0) + delta;
      if (fn === 'record_transfer') it.levels[String(a.p_to)] = (it.levels[String(a.p_to)] ?? 0) + qty;
      feed.unshift({ id: a.p_id, kind: fn === 'record_transfer' ? 'transfer' : fn === 'record_count' ? 'count' : a.p_kind, qty: delta,
        happened_at: new Date().toISOString(), sku: it.sku, item_name: it.name, unit: it.unit, person_name: 'James Carter',
        location_name: loc === MAIN ? 'Main kitchen' : 'Walk-in cooler', undone: false, reason: a.p_reason ?? null, ref: null, flag: null });
      return [{ id: a.p_id, duplicate: false, refused: false, reason: null, flag: null, here: it.levels[loc], total: total(it) }];
    }
    case 'undo_move': {
      const f = feed.find((x) => x.id === a.p_target);
      if (!f || f.undone) return [{ refused: true, reason: 'Already undone.' }];
      f.undone = true;
      const it = items.find((i) => i.sku === f.sku)!;
      const loc = f.location_name === 'Main kitchen' ? MAIN : WALK;
      it.levels[loc] -= Number(f.qty);
      return [{ id: a.p_id, refused: false, here: it.levels[loc], total: total(it) }];
    }
    default: throw new Error(`${fn} is not in preview mode yet.`);
  }
}
