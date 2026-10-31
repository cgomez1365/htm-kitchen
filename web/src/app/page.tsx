'use client';
// The front door: send everyone to the scan screen; Shell sends strangers to /login and an empty database to /setup.
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export default function Home() {
  const router = useRouter();
  useEffect(() => router.replace('/scan'), [router]);
  return <div className="p-6 text-muted">Opening…</div>;
}
