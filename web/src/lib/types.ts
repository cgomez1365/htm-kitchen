// Shapes the database returns (0005 doors, 0006 reads). Quantities arrive as numbers or numeric strings; num() reads both.
import type { Role } from './roles';

export const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v));

export interface Location { id: string; name: string; kind: 'kitchen' | 'storage' | 'site' | 'vehicle' }

export interface Item {
  id: string; sku: string; name: string; category: string; unit: string;
  min_level: number | string; par_level: number | string; price: number | string;
  supplier: string | null; spot: string | null; active: boolean;
  on_hand: number | string; here?: number | string | null; last_moved: string | null; codes: string | null;
}

export interface ItemDetail extends Item {
  levels: { id: string; name: string; kind: string; on_hand: number | string; last_at: string | null }[];
  code_list: { code: string; pack_qty: number | string; label: string | null; active: boolean }[];
  pulled_30: number | string;
}

export interface DoorResult {
  id: string | null; duplicate: boolean; refused: boolean; reason: string | null; flag: string | null;
  here: number | string | null; total: number | string | null;
}

export interface Lookup { found: boolean; item?: Item; packQty?: number | string; packLabel?: string | null; code?: string; retired?: boolean }

export interface FeedRow {
  id: string; kind: string; qty: number | string; reason: string | null; ref: string | null; flag: string | null;
  happened_at: string; sku: string; item_name: string; unit: string; person_name: string; location_name: string; undone: boolean;
}

export interface Who {
  manager: { id: string; display_name: string; role: Role; email: string } | null;
  device: { id: string; name: string } | null;
  locations: Location[];
  setup_needed: boolean;
}

export interface RosterPerson { id: string; display_name: string; role: Role; has_pin: boolean }

/** A person unlocked on a tablet with their PIN. The token goes with every scan they make. */
export interface Actor { token: string; staffId: string; name: string; role: Role; expiresAt: string }

export type ScanKind = 'receive' | 'issue' | 'return' | 'transfer' | 'count';

// ------------------------------------------------------------ Admin (0007) --
export interface Person {
  id: string; display_name: string; role: Role; email: string | null; active: boolean; linked: boolean; is_me: boolean;
  has_pin: boolean; pin_set_at: string | null; locked: boolean; on_tablet: boolean; last_scan: string | null;
}
export interface Tablet {
  id: string; name: string; active: boolean; email: string | null; locations: string[]; last_seen: string | null;
  people_on: number; pairing_until: string | null; paired_at: string | null;
}
export interface AdminLocation { id: string; name: string; kind: Location['kind']; active: boolean; stocked: number; tablets: number }
export interface Category { name: string; prefix: string; active: boolean; items: number; next_sku: string }
export interface Pairing { code: string; expires_at: string; device_id?: string }
