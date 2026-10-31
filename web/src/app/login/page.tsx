'use client';
/**
 * Two ways in (FQC R-12, adapted): a manager types their email and the 6-digit code it
 * receives; a kitchen tablet is signed in once with its own email and password by IT and
 * stays signed in. Chefs and staff never use this page - they tap their name on the tablet.
 * Supabase: Email OTP length must be 6 (the project default is 8; FQC trap).
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
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
            <p className="text-xs text-muted">IT does this once per tablet. After that, people tap their name and enter their PIN.</p>
          </>
        )}
        {msg && <p className="text-sm font-semibold text-out">{msg}</p>}
      </div>
      {/127\.0\.0\.1:54321|localhost:54321/.test(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '') && (
        <p className="mt-4 text-center text-xs text-muted">Local test server: codes are not emailed. They show at{' '}
          <a className="underline" href="http://127.0.0.1:54321/local" target="_blank" rel="noreferrer">127.0.0.1:54321/local</a>.</p>
      )}
    </div>
  );
}
