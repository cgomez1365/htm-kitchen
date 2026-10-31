// The browser's Supabase client, holding the caller's own session. Row Level Security and the
// doors decide what it may read and write (FQC R-05), so the public anon key is safe to ship.
import { createBrowserClient } from '@supabase/ssr';

let client: ReturnType<typeof createBrowserClient> | null = null;

export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('This copy is not connected to a database yet (NEXT_PUBLIC_SUPABASE_URL is missing).');
  client ??= createBrowserClient(url, key);
  return client;
}

/** Preview mode: invented data, no sign-in. Never on Vercel (FQC: preview is refused there by design). */
export const isPreview = (): boolean =>
  process.env.NEXT_PUBLIC_HK_PREVIEW === '1' && process.env.NEXT_PUBLIC_VERCEL_ENV === undefined;
