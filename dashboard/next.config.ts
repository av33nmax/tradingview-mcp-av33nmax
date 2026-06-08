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

  // 2026-05-06: experimented with `turbopack: { root: process.cwd() }` to scope
  // the file watcher to dashboard/ and avoid HMR recompiles on every
  // journal/watcher-checks-raw/*.jsonl append. The change was correct in
  // principle (Turbopack auto-detected the parent repo as the workspace root
  // because of the outer package-lock.json, then thrashed on watcher writes)
  // but in practice it triggered a cold-cache rebuild so heavy that it
  // crashed the user's already-memory-pressured laptop twice on launch.
  // Reverted. The "inferred your workspace root" warning is harmless — the
  // CPU cost is what we'll mitigate via a different approach (likely moving
  // journal writes to a path Turbopack ignores via .gitignore-style exclusion,
  // or running the dashboard in production mode `npm start` instead of `dev`).
  // See SSE cleanup fix in commit 9c9763b which IS shipped — that addresses
  // the zombie-subscriber-on-refresh leak independently.
};

export default nextConfig;
