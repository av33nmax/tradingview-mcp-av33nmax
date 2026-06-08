import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Match the US dashboard pattern — accept dev requests from Tailscale / LAN
  // so the dashboard is usable from a phone or other devices on the network.
  allowedDevOrigins: [
    "localhost",
    "127.0.0.1",
    "100.*.*.*", // Tailscale CGNAT range
    "192.168.*.*", // home LAN
    "*.ts.net", // Tailscale MagicDNS
  ],
};

export default nextConfig;
