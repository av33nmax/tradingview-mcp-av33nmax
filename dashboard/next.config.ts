import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the Next.js dev server to accept requests from non-localhost origins —
  // required so the dashboard is usable from a phone via Tailscale, LAN, etc.
  // If we ever expose publicly, tighten this to specific origins instead of "*".
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "100.*.*.*",          // Tailscale CGNAT range
    "192.168.*.*",        // home LAN
    "*.ts.net",           // Tailscale MagicDNS
  ],
};

export default nextConfig;
