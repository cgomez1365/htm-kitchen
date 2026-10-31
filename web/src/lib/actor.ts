/**
 * Who is scanning on this tablet. A person taps their name and enters their own PIN
 * (CEO, 2026-10-29: name + PIN, not name only); the database hands back a token for
 * 12 hours, and every scan carries it. The screen locks itself after 10 minutes
 * without a touch, so the next person cannot scan under the last one's name - but a
 * scan already queued offline keeps its token and still counts, because the database
 * judges it by when it was made (resolve_actor, p_at).
 */
import type { Actor } from './types';

const KEY = 'hk.actor';
export const LOCK_AFTER_MS = 10 * 60 * 1000;

export function loadActor(): Actor | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Actor & { lastTouch?: number };
    if (new Date(a.expiresAt).getTime() < Date.now()) return null;
    if (a.lastTouch && Date.now() - a.lastTouch > LOCK_AFTER_MS) return null;
    return a;
  } catch { return null; }
}

export function saveActor(a: Actor | null): void {
  try {
    if (a) localStorage.setItem(KEY, JSON.stringify({ ...a, lastTouch: Date.now() }));
    else localStorage.removeItem(KEY);
  } catch { /* storage off: the person signs in again next time */ }
}

export function touchActor(): void {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) localStorage.setItem(KEY, JSON.stringify({ ...JSON.parse(raw), lastTouch: Date.now() }));
  } catch { /* fine */ }
}
