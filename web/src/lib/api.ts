/**
 * Every call the screens make. Reads are the 0006 functions; writes are the 0005 doors.
 * A door answers a refusal as a row (refused = true) and the screen shows its reason;
 * a thrown error means the call itself failed (no signal, server down) and the offline
 * queue keeps the scan and retries (FQC: 4xx is a verdict, 5xx and no answer are not).
 * In preview mode the same calls answer from preview.ts with invented data.
 */
import { browserClient, isPreview } from './supabase-browser';
import { preview } from './preview';
import type { DoorResult, FeedRow, Item, ItemDetail, Lookup, RosterPerson, Who } from './types';
import type { Role } from './roles';

export class NetworkError extends Error {}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  if (isPreview()) return preview(fn, args) as Promise<T>;
  let res;
  try {
    res = await browserClient().rpc(fn, args);
  } catch (e) {
    throw new NetworkError(`No answer from the server. ${(e as Error).message}`);
  }
  const { data, error } = res;
  if (error) {
    // PostgREST and Postgres failures that are not verdicts: no connection, timeouts, resources (FQC review C18).
    if (!error.code || /^(08|53|57|58|PGRST00)/.test(error.code) || /fetch|network/i.test(error.message)) {
      throw new NetworkError(error.message);
    }
    throw new Error(error.message);
  }
  return data as T;
}

const one = <T>(rows: T | T[]): T => (Array.isArray(rows) ? rows[0] : rows);

export const api = {
  whoami: () => rpc<Who>('whoami'),
  bootstrap: (name: string) => rpc<string>('bootstrap_first_director', { p_name: name }),
  claim: () => rpc<boolean>('claim_my_staff'),
  roster: () => rpc<RosterPerson[]>('tablet_roster'),
  signIn: async (staffId: string, pin: string) =>
    one(await rpc<{ token: string | null; expires_at: string | null; display_name: string | null; role: Role | null; refused: boolean; locked: boolean; reason: string | null }[]>(
      'tablet_sign_in', { p_staff: staffId, p_pin: pin })),
  signOut: (token: string) => rpc<boolean>('tablet_sign_out', { p_token: token }),

  search: (p: Record<string, unknown>) => rpc<{ rows: Item[]; total: number; offset: number; limit: number }>('item_search', { p }),
  lookup: (code: string, locationId: string | null) => rpc<Lookup>('lookup_code', { p_code: code, p_location: locationId }),
  detail: (id: string) => rpc<ItemDetail>('item_detail', { p_item: id }),
  feed: (locationId: string | null, itemId: string | null = null, limit = 30) =>
    rpc<FeedRow[]>('movement_feed', { p_location: locationId, p_item: itemId, p_limit: limit }),
  dashboard: (locationId: string | null) => rpc<Record<string, unknown>>('dashboard', { p_location: locationId }),
  nextSku: (category: string) => rpc<string>('next_sku', { p_category: category }),
  saveItem: (p: Record<string, unknown>) => rpc<string>('save_item', { p }),
  addCode: (itemId: string, code: string, pack: number, label: string | null) =>
    rpc<boolean>('add_code', { p_item: itemId, p_code: code, p_pack: pack, p_label: label }),

  move: async (a: { id: string; token: string | null; at: string; item: string; location: string; kind: string; qty: number; reason?: string | null; note?: string | null }) =>
    one(await rpc<DoorResult[] | DoorResult>('record_move', {
      p_id: a.id, p_token: a.token, p_at: a.at, p_item: a.item, p_location: a.location, p_kind: a.kind, p_qty: a.qty,
      p_reason: a.reason ?? null, p_note: a.note ?? null, p_ref: null })),
  transfer: async (a: { id: string; idIn: string; token: string | null; at: string; item: string; from: string; to: string; qty: number }) =>
    one(await rpc<DoorResult[] | DoorResult>('record_transfer', {
      p_id: a.id, p_id_in: a.idIn, p_token: a.token, p_at: a.at, p_item: a.item, p_from: a.from, p_to: a.to, p_qty: a.qty, p_note: null })),
  count: async (a: { id: string; token: string | null; at: string; item: string; location: string; counted: number }) =>
    one(await rpc<DoorResult[] | DoorResult>('record_count', {
      p_id: a.id, p_token: a.token, p_at: a.at, p_item: a.item, p_location: a.location, p_counted: a.counted, p_note: null })),
  undo: async (a: { id: string; token: string | null; at: string; target: string }) =>
    one(await rpc<DoorResult[] | DoorResult>('undo_move', { p_id: a.id, p_token: a.token, p_at: a.at, p_target: a.target })),
};
