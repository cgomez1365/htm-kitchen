/**
 * The send queue: a scan survives no signal, a force-quit and a dead battery (FQC's
 * offline engine, the same idea). Walk-in coolers and basements have no Wi-Fi.
 *
 * Every scan gets its id HERE, before it is sent, and is stored in IndexedDB first.
 * The door is idempotent on that id, so sending it again after a lost answer is
 * one movement, never two. An answer of refused = true is a verdict: the scan stops
 * and shows why. No answer at all keeps it and retries on 'online' and every 30 s.
 * Safari has no Background Sync, so the retry is the page's own job.
 */
import Dexie, { type Table } from 'dexie';
import { api, NetworkError } from './api';
import type { DoorResult } from './types';

export type QueuedKind = 'move' | 'transfer' | 'count' | 'undo';
export interface Queued {
  id: string;
  kind: QueuedKind;
  args: Record<string, unknown>;
  label: string;
  status: 'waiting' | 'refused' | 'done';
  reason?: string;
  tries: number;
  createdAt: string;
}

class QueueDB extends Dexie {
  scans!: Table<Queued, string>;
  constructor() {
    super('hope-kitchen');
    this.version(1).stores({ scans: 'id, status, createdAt' });
  }
}

let db: QueueDB | null = null;
const getDb = () => (db ??= new QueueDB());

export const newId = (): string => crypto.randomUUID();

async function send(q: Queued): Promise<DoorResult> {
  const a = q.args as never;
  switch (q.kind) {
    case 'move': return api.move(a);
    case 'transfer': return api.transfer(a);
    case 'count': return api.count(a);
    case 'undo': return api.undo(a);
  }
}

/**
 * Store first, then try to send. Returns the door's answer, or null when the scan
 * is waiting for signal (it is safe: it will go on its own).
 */
export async function submit(kind: QueuedKind, args: Record<string, unknown>, label: string): Promise<DoorResult | null> {
  const q: Queued = { id: String(args.id), kind, args, label, status: 'waiting', tries: 0, createdAt: new Date().toISOString() };
  await getDb().scans.put(q);
  notify();
  return attempt(q);
}

async function attempt(q: Queued): Promise<DoorResult | null> {
  try {
    const r = await send(q);
    await getDb().scans.update(q.id, r.refused ? { status: 'refused', reason: r.reason ?? 'Refused.', tries: q.tries + 1 } : { status: 'done', tries: q.tries + 1 });
    notify();
    return r;
  } catch (e) {
    if (e instanceof NetworkError) {
      await getDb().scans.update(q.id, { tries: q.tries + 1, reason: 'Waiting for signal' });
      notify();
      return null;
    }
    await getDb().scans.update(q.id, { status: 'refused', reason: (e as Error).message, tries: q.tries + 1 });
    notify();
    throw e;
  }
}

let flushing = false;
export async function flush(): Promise<void> {
  if (flushing || typeof navigator !== 'undefined' && navigator.onLine === false) return;
  flushing = true;
  try {
    const waiting = await getDb().scans.where('status').equals('waiting').sortBy('createdAt');
    for (const q of waiting) {
      // null = still no signal: stop here so scans go in the order they were made.
      if ((await attempt(q).catch(() => undefined)) === null) break;
    }
  } finally { flushing = false; }
}

export async function pending(): Promise<Queued[]> {
  return getDb().scans.where('status').anyOf('waiting', 'refused').sortBy('createdAt');
}

/** A refused scan is shown until someone reads it; dismissing it changes nothing in the database. */
export async function dismiss(id: string): Promise<void> { await getDb().scans.update(id, { status: 'done' }); notify(); }

const listeners = new Set<() => void>();
export const onQueueChange = (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => fn());

let started = false;
export function startQueue(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.addEventListener('online', () => void flush());
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void flush(); });
  setInterval(() => void flush(), 30_000);
  void flush();
}
