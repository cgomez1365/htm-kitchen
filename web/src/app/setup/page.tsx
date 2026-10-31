'use client';
/**
 * First run on an empty database: the signed-in person becomes the Director
 * (bootstrap_first_director refuses once anyone exists). Turn off open sign-ups in
 * Supabase Auth before going live so nobody else can be first.
 */
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/lib/api';

export default function Setup() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const create = async () => {
    setMsg(null);
    try { await api.bootstrap(name); router.replace('/scan'); }
    catch (e) { setMsg(/Sign in first|permission/i.test((e as Error).message) ? 'Sign in with your email code first.' : (e as Error).message); }
  };
  return (
    <div className="mx-auto max-w-sm p-6 pt-16">
      <div className="card space-y-3">
        <h1 className="text-xl font-bold">Set up Hope Kitchen</h1>
        <p className="text-sm text-muted">You are the first person here, so you become the Director: you add everyone else and the kitchen tablets.</p>
        <label className="block"><span className="label-sm">Your full name</span><input className="field mt-1" value={name} onChange={(e) => setName(e.target.value)} /></label>
        <button className="btn-primary w-full" disabled={!name.trim()} onClick={create}>Become the Director</button>
        {msg && <p className="text-sm font-semibold text-out">{msg}</p>}
      </div>
    </div>
  );
}
