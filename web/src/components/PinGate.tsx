'use client';
/**
 * The tablet's sign-in: tap your name, type your PIN. The database checks the PIN
 * (bcrypt), counts wrong tries where no session can forge them, and answers a refusal
 * as a row, which is shown here word for word.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { saveActor } from '@/lib/actor';
import { ROLE_NAMES } from '@/lib/roles';
import type { Actor, RosterPerson } from '@/lib/types';

const initials = (n: string) => n.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

export default function PinGate({ onIn }: { onIn: (a: Actor) => void }) {
  const [people, setPeople] = useState<RosterPerson[] | null>(null);
  const [who, setWho] = useState<RosterPerson | null>(null);
  const [pin, setPinState] = useState('');
  // The PIN lives in a ref too: keys typed fast (or by a scanner) arrive before React re-renders,
  // and Enter must read every digit typed, not the last rendered value (seen 2026-10-29 in preview).
  const pinRef = useRef('');
  const setPin = (v: string | ((p: string) => string)) => {
    pinRef.current = typeof v === 'function' ? v(pinRef.current) : v;
    setPinState(pinRef.current);
  };
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.roster().then(setPeople).catch((e: Error) => setMsg(e.message)); }, []);

  const press = async (k: string) => {
    if (busy || !who) return;
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    if (k !== 'go') return setPin((p) => (p.length < 8 ? p + k : p));
    setBusy(true); setMsg(null);
    try {
      const r = await api.signIn(who.id, pinRef.current);
      setPin('');
      if (r.refused || !r.token) return setMsg(r.reason ?? 'Not signed in.');
      const a: Actor = { token: r.token, staffId: who.id, name: r.display_name ?? who.display_name, role: r.role ?? who.role, expiresAt: r.expires_at ?? '' };
      saveActor(a);
      onIn(a);
    } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!who) return;
      if (/^[0-9]$/.test(e.key)) void press(e.key);
      else if (e.key === 'Backspace') void press('del');
      else if (e.key === 'Enter') void press('go');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!who) return (
    <div>
      <h1 className="text-2xl font-bold">Who is scanning?</h1>
      <p className="mb-4 text-muted">Tap your name. Every scan is saved with it.</p>
      {msg && <p className="mb-3 font-semibold text-out">{msg}</p>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        {(people ?? []).filter((p) => p.has_pin).map((p) => (
          <button key={p.id} onClick={() => { setWho(p); setPin(''); setMsg(null); }} className="card text-center active:scale-[.98]">
            <div className="mx-auto mb-2 grid h-12 w-12 place-items-center rounded-full border border-line bg-surface2 font-bold">{initials(p.display_name)}</div>
            <div className="font-semibold">{p.display_name}</div><div className="text-xs text-muted">{ROLE_NAMES[p.role]}</div>
          </button>
        ))}
      </div>
      {people && !people.some((p) => p.has_pin) && <div className="card text-muted">Nobody has a PIN yet. A Director sets PINs for each person.</div>}
    </div>
  );

  return (
    <div className="mx-auto max-w-xs text-center">
      <div className="mx-auto mb-2 grid h-14 w-14 place-items-center rounded-full border border-line bg-surface2 text-lg font-bold">{initials(who.display_name)}</div>
      <h2 className="text-xl font-bold">{who.display_name}</h2><p className="text-muted">Enter your PIN</p>
      <div className="my-4 flex justify-center gap-3">{Array.from({ length: Math.max(4, pin.length) }, (_, i) => (
        <i key={i} className={`h-3.5 w-3.5 rounded-full border-2 ${i < pin.length ? 'border-accent bg-accent' : 'border-line'}`} />))}</div>
      <div className="grid grid-cols-3 gap-2.5">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => <button key={k} className="btn h-14 text-2xl" onClick={() => press(k)}>{k}</button>)}
        <button className="btn h-14 text-sm" onClick={() => press('del')}>Delete</button>
        <button className="btn h-14 text-2xl" onClick={() => press('0')}>0</button>
        <button className="btn-primary h-14 text-sm" disabled={busy || pin.length < 4} onClick={() => press('go')}>Sign in</button>
      </div>
      {msg && <p className="mt-3 font-semibold text-out">{msg}</p>}
      <button className="btn-ghost mt-3" onClick={() => setWho(null)}>Not {who.display_name.split(' ')[0]}?</button>
    </div>
  );
}
