/**
 * Server-only Supabase clients for the three things a browser cannot do itself: make a
 * manager's sign-in, make a tablet's sign-in, and trade a pairing code for a tablet session.
 *
 *   callerClient()   the signed-in person's own session (from cookies): every door still
 *                    decides as them, so a route never widens what the caller may do.
 *   serviceClient()  the service role. Its key lives only in the server's environment
 *                    (SUPABASE_SERVICE_ROLE_KEY, never NEXT_PUBLIC_), and it is used only for
 *                    auth.admin calls and redeem_pairing(), which nothing else may call.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { createClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

const URL_ = () => process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';

export async function callerClient() {
  const store = await cookies();
  return createServerClient(URL_(), process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '', {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options?: CookieOptions }[]) => {
        try { list.forEach(({ name, value, options }) => store.set(name, value, options)); } catch { /* read-only in some contexts */ }
      },
    },
  });
}

export function serviceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!URL_() || !key) return null;
  return createClient(URL_(), key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** The caller, if they are an active Director; null otherwise. The doors check again. */
export async function directorOrNull() {
  const caller = await callerClient();
  const { data } = await caller.rpc('whoami');
  return (data as { manager?: { role?: string } } | null)?.manager?.role === 'director' ? caller : null;
}

export const randomSecret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString('base64url');
