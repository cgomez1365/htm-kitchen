'use client';
/**
 * The frame every working screen sits in: who this is (the tablet, or a manager), where
 * they are working, how many scans are still waiting for signal, and the way between
 * Scan and Items. It loads whoami() once and hands it down; a stranger is sent to /login.
 */
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { onQueueChange, pending, startQueue } from '@/lib/offline';
import { isPreview } from '@/lib/supabase-browser';
import type { Location, Who } from '@/lib/types';

interface ShellCtx { who: Who; loc: Location | null; setLoc: (id: string) => void }
const Ctx = createContext<ShellCtx | null>(null);
export const useShell = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useShell outside Shell');
  return c;
};

export default function Shell({ children }: { children: React.ReactNode }) {
  const router = useRouter(), path = usePathname();
  const [who, setWho] = useState<Who | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locId, setLocId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(0);
  const [refused, setRefused] = useState(0);

  useEffect(() => {
    api.whoami().then((w) => {
      if (w.setup_needed) return router.replace('/setup');
      if (!w.manager && !w.device) return router.replace('/login');
      setWho(w);
      let saved: string | null = null;
      try { saved = localStorage.getItem('hk.loc'); } catch { /* fine */ }
      setLocId(w.locations.some((l) => l.id === saved) ? saved : w.locations[0]?.id ?? null);
    }).catch((e: Error) => {
      if (/connected to a database/.test(e.message)) setError(e.message);
      else router.replace('/login');
    });
    startQueue();
    const refresh = () => pending().then((q) => { setWaiting(q.filter((x) => x.status === 'waiting').length); setRefused(q.filter((x) => x.status === 'refused').length); });
    refresh();
    return onQueueChange(refresh) as () => void;
  }, [router]);

  if (error) return <div className="mx-auto max-w-md p-6"><div className="card"><h1 className="text-lg font-bold">Not connected yet</h1><p className="mt-2 text-muted">{error}</p></div></div>;
  if (!who) return <div className="p-6 text-muted">Loading…</div>;
  const loc = who.locations.find((l) => l.id === locId) ?? null;
  const setLoc = (id: string) => { setLocId(id); try { localStorage.setItem('hk.loc', id); } catch { /* fine */ } };
  const tab = (href: string, label: string) => (
    <Link href={href} className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${path.startsWith(href) ? 'bg-accent/15 text-accent' : 'text-muted'}`}>{label}</Link>
  );

  return (
    <Ctx.Provider value={{ who, loc, setLoc }}>
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-2 px-4 py-2.5">
          <div className="mr-2 flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-accent font-black text-[#1a1204]">H</div>
            <div className="leading-tight"><div className="font-bold">Hope Kitchen</div>
              <div className="text-xs text-muted">{who.device ? who.device.name : who.manager?.display_name}{isPreview() ? ' · preview' : ''}</div></div>
          </div>
          <nav className="flex gap-1">{tab('/scan', 'Scan')}{tab('/items', 'Items')}</nav>
          <div className="ml-auto flex items-center gap-2">
            {waiting > 0 && <span className="pill bg-warn/15 text-warn" title="Saved on this device; they send on their own">{waiting} waiting for signal</span>}
            {refused > 0 && <Link href="/scan" className="pill bg-out/15 text-out">{refused} refused</Link>}
            {who.locations.length > 1 ? (
              <select className="field w-auto py-1.5 text-sm font-semibold" value={locId ?? ''} onChange={(e) => setLoc(e.target.value)}>
                {who.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            ) : <span className="text-sm font-semibold">{loc?.name ?? 'No location'}</span>}
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-5">{loc ? children : <div className="card">This {who.device ? 'tablet' : 'account'} has no location yet. A Director ties it to one.</div>}</main>
    </Ctx.Provider>
  );
}
