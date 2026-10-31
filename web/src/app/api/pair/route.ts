/**
 * POST /api/pair { code }   (anyone: this is how a new tablet gets in)
 * Trades a Director's one-time pairing code for that tablet's sign-in. The tablet gets a
 * fresh random password that no person ever sees, then signs itself in with it. A wrong,
 * used or expired code gets one plain answer; tries are capped per address.
 */
import { NextResponse } from 'next/server';
import { randomSecret, serviceClient } from '@/lib/supabase-server';

const tries = new Map<string, number[]>(); // per server instance: a brake, not the lock (the code space is ~10^12)
const WINDOW = 10 * 60e3, MAX = 10;

export async function POST(req: Request) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const recent = (tries.get(ip) ?? []).filter((t) => Date.now() - t < WINDOW);
  if (recent.length >= MAX) return NextResponse.json({ message: 'Too many tries. Wait 10 minutes.' }, { status: 429 });

  const admin = serviceClient();
  if (!admin) return NextResponse.json({ message: 'This server cannot pair tablets yet (no service key).' }, { status: 500 });
  const { code } = await req.json().catch(() => ({ code: '' }));
  const { data, error } = await admin.rpc('redeem_pairing', { p_code: String(code ?? '') });
  const hit = (Array.isArray(data) ? data[0] : data) as { device_id: string; email: string } | undefined;
  if (error || !hit?.device_id) {
    tries.set(ip, [...recent, Date.now()]);
    return NextResponse.json({ message: 'That code did not work. Codes last 15 minutes and work once: ask for a new one.' }, { status: 400 });
  }
  const password = randomSecret();
  const upd = await admin.auth.admin.updateUserById(hit.device_id, { password });
  if (upd.error) return NextResponse.json({ message: upd.error.message }, { status: 500 });
  return NextResponse.json({ email: hit.email, password });
}
