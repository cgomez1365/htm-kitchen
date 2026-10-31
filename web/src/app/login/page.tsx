'use client';
/**
 * Two ways in (FQC R-12, adapted): a manager types their email and the 6-digit code it
 * receives; a kitchen tablet is paired once with the code (or QR) a Director's Admin screen
 * shows, and stays signed in. A QR opens /login#pair=CODE: the code rides in the fragment,
 * which the browser never sends to a server. Chefs and staff never use this page - they tap
 * their name on the tablet.
 * Supabase: Email OTP length must be 6 (the project default is 8; FQC trap).
 */
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { browserClient } from '@/lib/supabase-browser';

export default function Login() {
  const router = useRouter();
  const [mode, setMode] = useState<'manager' | 'tablet'>('manager');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [pairCode, setPairCode] = useState('');
  const [usePassword, setUsePassword] = useState(false);

  const go = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const sendCode = () => go(async () => {
    const { error } = await browserClient().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false } });
    if (error) throw new Error(/not allowed|signups/i.test(error.message) ? 'That email is not set up. Ask a Director to add you.' : error.message);
    setSent(true);
  });
  const verify = () => go(async () => {
    const { error } = await browserClient().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    if (error) throw new Error('That code did not work. Codes expire after an hour; ask for a new one.');
    await api.claim().catch(() => false);
    router.replace('/scan');
  });
  const pair = (raw: string) => go(async () => {
    const creds = await api.pair(raw);
    const { error } = await browserClient().auth.signInWithPassword(creds);
    if (error) throw new Error(`Paired, but signing in failed: ${error.message}`);
    router.replace('/scan');
  });
  useEffect(() => {
    const m = window.location.hash.match(/pair=([A-Za-z0-9-]+)/);
    if (!m) return;
    history.replaceState(null, '', window.location.pathname);
    setMode('tablet'); setPairCode(m[1].toUpperCase().replace(/[^A-Z0-9]/g, ''));
    pair(m[1]);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tablet = () => go(async () => {
    const { error } = await browserClient().auth.signInWithPassword({ email: email.trim(), password });
    if (error) throw new Error('Email or password is wrong.');
    router.replace('/scan');
  });

  return (
    <div className="mx-auto max-w-sm p-6 pt-16">
      <div className="mb-6 flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-accent text-lg font-black text-[#1a1204]">H</div>
        <div><h1 className="text-xl font-bold">Hope Kitchen</h1><p className="text-sm text-muted">Hope the Mission</p></div>
      </div>
      <div className="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-surface2 p-1">
        {(['manager', 'tablet'] as const).map((m) => (
          <button key={m} onClick={() => { setMode(m); setMsg(null); }} className={`rounded-lg py-2 text-sm font-semibold ${mode === m ? 'bg-surface shadow-sm' : 'text-muted'}`}>
            {m === 'manager' ? 'Manager' : 'Kitchen tablet'}
          </button>
        ))}
      </div>
      <div className="card space-y-3">
        {mode === 'tablet' && !usePassword ? (
          <>
            <label className="block"><span className="label-sm">Pairing code from the Director&apos;s screen</span>
              <input className="field mt-1 tnum text-center font-mono text-2xl uppercase tracking-[.2em]" autoCapitalize="characters" autoComplete="off" maxLength={9}
                value={pairCode.length > 4 ? `${pairCode.slice(0, 4)}-${pairCode.slice(4)}` : pairCode}
                onChange={(e) => setPairCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))} autoFocus /></label>
            <button className="btn-primary w-full" disabled={busy || pairCode.length !== 8} onClick={() => pair(pairCode)}>{busy ? 'Pairing…' : 'Pair this tablet'}</button>
            <p className="text-xs text-muted">A Director adds the tablet under Admin → Tablets and gets a code. Pointing this tablet&apos;s camera at the QR there does this for you.</p>
            <button className="btn-ghost w-full text-xs" onClick={() => { setUsePassword(true); setMsg(null); }}>Use an email and password instead</button>
            {msg && <p className="text-sm font-semibold text-out">{msg}</p>}
          </>
        ) : (<>
        <label className="block"><span className="label-sm">Email</span>
          <input className="field mt-1" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} disabled={sent} /></label>
        {mode === 'manager' ? (sent ? (
          <>
            <label className="block"><span className="label-sm">6-digit code from your email</span>
              <input className="field mt-1 tnum text-center text-2xl tracking-[.4em]" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus /></label>
            <button className="btn-primary w-full" disabled={busy || code.length !== 6} onClick={verify}>Sign in</button>
            <button className="btn-ghost w-full" onClick={() => { setSent(false); setCode(''); }}>Use a different email</button>
          </>
        ) : <button className="btn-primary w-full" disabled={busy || !email.includes('@')} onClick={sendCode}>Email me a code</button>
        ) : (
          <>
            <label className="block"><span className="label-sm">Tablet password</span>
              <input className="field mt-1" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            <button className="btn-primary w-full" disabled={busy || !password} onClick={tablet}>Sign this tablet in</button>
            <button className="btn-ghost w-full text-xs" onClick={() => { setUsePassword(false); setMsg(null); }}>Use a pairing code instead</button>
          </>
        )}
        {msg && <p className="text-sm font-semibold text-out">{msg}</p>}
        </>)}
      </div>
      {/127\.0\.0\.1:54321|localhost:54321/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '') && (
        <p className="mt-4 text-center text-xs text-muted">Local test server: codes are not emailed. They show at{' '}
          <a className="underline" href="http://127.0.0.1:54321/local" target="_blank" rel="noreferrer">127.0.0.1:54321/local</a>.</p>
      )}
    </div>
  );
}
