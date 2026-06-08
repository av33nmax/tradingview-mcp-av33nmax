#!/usr/bin/env node
/**
 * launch_tv_with_tabs.mjs — launch TradingView Desktop with CDP and wait until
 * it has finished restoring its saved chart tabs (not just "CDP is up").
 *
 * Problem this solves:
 *   The old bash script returned as soon as port 9222 was listening, but TV
 *   takes another 10-30s after that to restore its tabs from the previous
 *   session. If the user ran `premarket_setup.mjs` in that window, it found
 *   no chart tabs and errored out.
 *
 * This script:
 *   1. If CDP is already up with at least one TV chart tab → no-op, done.
 *   2. Otherwise, launches TV via the bash script (kills any existing TV).
 *   3. Waits for CDP to respond.
 *   4. Polls /json/list until at least one `/chart/` tab appears (max 45s).
 *   5. If the expected SPY/QQQ chart IDs are missing after timeout, prints
 *      a helpful message but still exits 0 — user may be on a different
 *      set of layouts.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");
const CDP_PORT = 9222;

// These are the saved chart layout IDs that the user relies on. Hardcoded
// because they're tied to the user's TV account. Change here if layouts move.
const EXPECTED_CHART_IDS = [
  { id: "PbLW86HI", label: "SPY (Iceman Style)" },
  { id: "o6Tc3OIX", label: "QQQ (Iceman Style)" },
];

async function cdpUp() {
  try {
    const res = await fetch(`http://localhost:${CDP_PORT}/json/version`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function listChartTabs() {
  try {
    const res = await fetch(`http://localhost:${CDP_PORT}/json/list`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return [];
    const pages = await res.json();
    return pages.filter(
      (p) => p?.type === "page" && typeof p.url === "string" && /tradingview\.com\/chart\//.test(p.url),
    );
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitUntil(predicate, { maxMs, intervalMs = 500, label }) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    process.stdout.write(".");
    await sleep(intervalMs);
  }
  console.log(`\n  timeout after ${Math.round(maxMs / 1000)}s — ${label}`);
  return false;
}

function launchTvViaBash() {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["scripts/launch_tv_debug_mac.sh", String(CDP_PORT)], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`launch_tv_debug_mac.sh exited with code ${code}`));
    });
  });
}

(async () => {
  console.log("──────────────────────────────────────────");
  console.log(" TradingView launch — ensure tabs present");
  console.log("──────────────────────────────────────────");

  // Shortcut: if CDP is up AND at least one chart tab exists, assume TV is
  // already in a good state and do nothing.
  if (await cdpUp()) {
    const existing = await listChartTabs();
    if (existing.length > 0) {
      console.log(`✅ TradingView already running with ${existing.length} chart tab(s):`);
      for (const t of existing) console.log(`   - ${t.url}`);
      process.exit(0);
    }
    console.log("TV is running but no chart tabs yet — will wait for restore...");
  } else {
    console.log("Launching TradingView with CDP...");
    try { await launchTvViaBash(); } catch (e) { console.error(e.message); process.exit(1); }
  }

  // At this point: CDP should be up (either was, or bash script got it up).
  // Wait for chart tabs to appear from TV's session restore.
  console.log("\nWaiting for chart tabs to load");
  process.stdout.write("  ");
  const ok = await waitUntil(
    async () => (await listChartTabs()).length > 0,
    { maxMs: 45000, intervalMs: 1000, label: "no chart tabs appeared" },
  );
  console.log("");

  const tabs = await listChartTabs();
  if (!ok || tabs.length === 0) {
    console.log("⚠ TradingView didn't restore any chart tabs.");
    console.log("  This can happen if TV was force-killed (session not saved).");
    console.log("  Open your SPY and QQQ charts manually in TV, then retry.");
    process.exit(1);
  }

  console.log(`✅ ${tabs.length} chart tab(s) loaded:`);
  for (const t of tabs) console.log(`   - ${t.url}`);

  // Check that the expected SPY / QQQ layouts are among them (non-fatal)
  const missing = EXPECTED_CHART_IDS.filter(
    (e) => !tabs.some((t) => t.url.includes(`/chart/${e.id}`)),
  );
  if (missing.length) {
    console.log("\n⚠ Expected layouts NOT found:");
    for (const m of missing) console.log(`   - ${m.label}  (/chart/${m.id})`);
    console.log("  premarket_setup.mjs may skip the missing ticker(s).");
    console.log("  Open those layouts in TV manually and retry.");
  } else {
    console.log("\n✅ Both expected layouts (SPY + QQQ) are present.");
  }

  process.exit(0);
})().catch((e) => {
  console.error("FATAL:", e?.message ?? e);
  process.exit(1);
});
