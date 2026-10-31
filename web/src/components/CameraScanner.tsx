'use client';
/**
 * The device camera as a scanner. Safari (iPad, iPhone) has no BarcodeDetector, so the
 * decoding is done in JavaScript by ZXing: QR, Code 128, EAN/UPC. Needs HTTPS (Vercel)
 * or localhost. The same label held in view is one scan, not twenty (2 s, as the Mac app).
 */
import { useEffect, useRef, useState } from 'react';

export default function CameraScanner({ onCode, onClose }: { onCode: (code: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const last = useRef({ code: '', at: 0 });

  useEffect(() => {
    let controls: { stop: () => void } | null = null;
    let cancelled = false;
    (async () => {
      try {
        const { BrowserMultiFormatReader } = await import('@zxing/browser');
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: 'environment' } } }, video.current!,
          (result) => {
            if (!result || cancelled) return;
            const code = result.getText(), now = Date.now();
            if (code === last.current.code && now - last.current.at < 2000) return;
            last.current = { code, at: now };
            navigator.vibrate?.(40);
            onCode(code);
          });
      } catch (e) {
        const m = (e as Error).message || String(e);
        setMsg(/Permission|NotAllowed/i.test(m) ? 'Camera access is off. Allow the camera for this site in Settings, then try again.'
          : /secure|https/i.test(m) ? 'The camera needs the https:// address.' : `The camera could not start: ${m}`);
      }
    })();
    return () => { cancelled = true; controls?.stop(); };
  }, [onCode]);

  return (
    <div className="card overflow-hidden p-0">
      <div className="relative aspect-[4/3] bg-black">
        <video ref={video} className="h-full w-full object-cover" muted playsInline />
        <div className="pointer-events-none absolute inset-[18%] rounded-2xl border-2 border-white/70" />
      </div>
      <div className="flex items-center justify-between p-3">
        <span className="text-sm text-muted">{msg ?? 'Hold the label inside the square, 15–30 cm away.'}</span>
        <button className="btn-ghost" onClick={onClose}>Stop camera</button>
      </div>
    </div>
  );
}
