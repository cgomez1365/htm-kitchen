import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Hope Kitchen',
  description: 'Kitchen inventory for Hope the Mission: scan in, scan out, live stock.',
};

// Phone and iPad first: no zoom on focus, the page fills the screen.
export const viewport: Viewport = { width: 'device-width', initialScale: 1, maximumScale: 1, themeColor: '#e8930c' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
