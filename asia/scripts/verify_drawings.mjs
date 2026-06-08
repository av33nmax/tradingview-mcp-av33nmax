#!/usr/bin/env node
/**
 * verify_drawings.mjs — sanity-check that the Stage 4 drawings are actually
 * on the HSI / HSTECH tabs. Cross-references asia/state/last_drawn_shapes.json
 * against TradingView's live shape list per tab.
 *
 * Usage: node asia/scripts/verify_drawings.mjs
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTabSession, listTabs } from "../lib/multi_tab.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASIA_ROOT = path.resolve(__dirname, "..");
const STATE_FILE = path.join(ASIA_ROOT, "state", "last_drawn_shapes.json");

const CHART_PATH = `window.TradingViewApi._activeChartWidgetWV.value()`;

async function main() {
  const state = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
  const tabs = await listTabs();
  console.log(`\nFound ${tabs.length} TradingView tab(s) open.\n`);

  for (const [tabId, expectedIds] of Object.entries(state)) {
    const tab = tabs.find((t) => t.id === tabId);
    const label = tab ? `${tab.title}` : `(tab ${tabId.slice(0, 8)} — not found)`;
    console.log(`📊 ${label}`);
    console.log(`   Tab ID: ${tabId}`);
    console.log(`   Expected shapes (from state): ${expectedIds.length}`);

    if (!tab) {
      console.log(`   ⚠️  Tab no longer exists in TradingView\n`);
      continue;
    }

    try {
      const liveShapes = await withTabSession(tabId, async (run) => {
        return run(`${CHART_PATH}.getAllShapes().map(s => ({ id: s.id, name: s.name }))`);
      });

      const liveIds = new Set((liveShapes || []).map((s) => s.id));
      const present = expectedIds.filter((id) => liveIds.has(id));
      const missing = expectedIds.filter((id) => !liveIds.has(id));

      console.log(`   Total shapes on chart: ${liveShapes.length}`);
      console.log(`   ✅ Present from our state: ${present.length}/${expectedIds.length}`);

      // Show shape breakdown by type
      const byName = {};
      for (const s of liveShapes) {
        byName[s.name] = (byName[s.name] || 0) + 1;
      }
      const breakdown = Object.entries(byName)
        .map(([n, c]) => `${n}:${c}`)
        .join(", ");
      console.log(`   Shape types on chart: ${breakdown || "(none)"}`);

      if (missing.length > 0) {
        console.log(`   ⚠️  Missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}`);
      }

      // Sample first few of OURS (with text labels)
      const oursWithText = await withTabSession(tabId, async (run) => {
        const ids = JSON.stringify(present.slice(0, 5));
        return run(`
          (() => {
            const api = ${CHART_PATH};
            const ids = ${ids};
            const out = [];
            for (const id of ids) {
              try {
                const shape = api.getShapeById(id);
                if (!shape) continue;
                let text = '';
                try { text = shape.getProperties()?.text || ''; } catch (e) {}
                let points = [];
                try { points = shape.getPoints() || []; } catch (e) {}
                out.push({ id, text, points: points.map(p => ({ price: p.price })) });
              } catch (e) {}
            }
            return out;
          })()
        `);
      });
      if (oursWithText && oursWithText.length) {
        console.log(`   Sample drawings:`);
        for (const s of oursWithText) {
          const priceList = s.points.map((p) => Math.round(p.price)).join("→");
          console.log(`     - ${s.text || "(no text)"}  @ ${priceList}`);
        }
      }
    } catch (err) {
      console.log(`   ❌ Error reading shapes: ${err.message}`);
    }

    console.log("");
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
