/**
 * POST /api/admin/accounts   (Director only)
 *   { kind: 'tablet', name, locations }  makes the tablet's sign-in (an address nobody reads, a
 *                                         password nobody sees), registers it, and opens a pairing
 *                                         code: the Director's screen shows the code and its QR.
 *   { kind: 'manager', email }           makes sure a manager's sign-in exists, so their emailed
 *                                         code works the first time (sign-ups stay off in Supabase).
 * Every database write still goes through a door AS the Director (callerClient).
 */
import { NextResponse } from 'next/server';
import { directorOrNull, randomSecret, serviceClient } from '@/lib/supabase-server';

const say = (status: number, message: string) => NextResponse.json({ message }, { status });
const TABLET_DOMAIN = process.env.HK_TABLET_EMAIL_DOMAIN || 'tablets.hope-kitchen.invalid';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const caller = await directorOrNull();
  if (!caller) return say(403, 'Only a Director adds sign-ins.');
  const admin = serviceClient();
  if (!admin) return say(500, 'This server has no SUPABASE_SERVICE_ROLE_KEY yet, so it cannot make sign-ins.');

  if (body.kind === 'manager') {
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) return say(400, 'That email does not look right.');
    const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error && !/already|exists|registered/i.test(error.message)) return say(400, error.message);
    return NextResponse.json({ email, created: !error });
  }

  if (body.kind === 'tablet') {
    const name = String(body.name ?? '').trim();
    const locations = Array.isArray(body.locations) ? body.locations.map(String) : [];
    if (!name) return say(400, 'Give the tablet a name.');
    const email = `tablet-${crypto.randomUUID().slice(0, 8)}@${TABLET_DOMAIN}`;
    const made = await admin.auth.admin.createUser({ email, password: randomSecret(), email_confirm: true });
    if (made.error || !made.data.user) return say(400, made.error?.message ?? 'Could not make the tablet sign-in.');
    const reg = await caller.rpc('register_device', { p_email: email, p_name: name, p_locations: locations });
    if (reg.error) {
      await admin.auth.admin.deleteUser(made.data.user.id); // never registered: nothing points at it
      return say(400, reg.error.message);
    }
    const pair = await caller.rpc('start_pairing', { p_device: reg.data });
    if (pair.error) return say(400, pair.error.message);
    return NextResponse.json({ device_id: reg.data, ...(pair.data as { code: string; expires_at: string }) });
  }

  return say(400, 'Unknown request.');
}
