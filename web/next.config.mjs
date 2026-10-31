// Every API answer and every page that shows stock must be fresh (FQC: Cache-Control no-store on /api).
/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [{ key: 'X-Frame-Options', value: 'DENY' }, { key: 'Referrer-Policy', value: 'same-origin' }] }];
  },
};
export default nextConfig;
