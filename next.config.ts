import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // Fase 6.7 / bloque 6 — página pública de cotización (/q/{token}): sin caché, sin indexación, sin Referer y sin marcos.
  // El token viaja en la URL: estas cabeceras evitan que se guarde en cachés, se envíe como Referer o se incruste.
  async headers() {
    return [
      {
        source: '/q/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0' },
          { key: 'Pragma', value: 'no-cache' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        ],
      },
    ]
  },
};

export default nextConfig;
