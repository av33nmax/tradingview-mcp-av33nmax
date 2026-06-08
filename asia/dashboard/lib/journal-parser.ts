/**
 * Parse the markdown journals we generate via premarket_hsi.mjs and
 * post_open_orb.mjs into structured data the dashboard can render.
 *
 * The journals follow a stable section structure (## Stage N — Title),
 * so we can match section headers + extract specific lines/tables.
 */

export type Levels = {
  source?: string;
  prev_high?: number;
  prev_low?: number;
  prev_close?: number;
  prev_open?: number;
  prev_range_pct?: number;
};

export type ORBTrigger = {
  orb_high: number;
  orb_low: number;
  range: number;
  long: { entry: number; stop: number; T1: number; T2: number };
  short: { entry: number; stop: number; T1: number; T2: number };
  range_vs_atr?: number;
};

export type MarketBlock = {
  levels?: Levels;
  mtf?: {
    alignment?: string;
    key_levels?: Array<{ type: string; price: number; tf: string }>;
    fvg_zones?: Array<{
      type: "bullish" | "bearish";
      low: number;
      high: number;
      tf: string;
    }>;
  };
  orb?: ORBTrigger;
};

export type ParsedJournal = {
  date: string | null;
  generated_at: string | null;
  /**
   * Map of instrument key (lowercase, e.g. "mhi", "tencent") to its block.
   * Populated dynamically from `### KEY` headers in the journal — supports
   * any number of instruments without code changes.
   */
  instruments: Record<string, MarketBlock>;
  premarket_verdict?: string;
  gates?: Array<{ name: string; status: string }>;
};

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function parseLevelsBlock(block: string): Levels {
  const out: Levels = {};
  const src = block.match(/Source:\s*`([^`]+)`/);
  if (src) out.source = src[1];

  const rows: Array<[RegExp, keyof Levels]> = [
    [/Prior High \(PDH\)\s*\|\s*([\d,.]+)/, "prev_high"],
    [/Prior Low\s*\(PDL\)\s*\|\s*([\d,.]+)/, "prev_low"],
    [/Prior Close \(PDC\)\s*\|\s*([\d,.]+)/, "prev_close"],
    [/Prior Open\s*\|\s*([\d,.]+)/, "prev_open"],
    [/Prior Range\s*\|\s*([\d.]+)%/, "prev_range_pct"],
  ];
  for (const [re, key] of rows) {
    const m = block.match(re);
    if (m) (out as Record<string, number | undefined>)[key as string] = num(m[1]);
  }
  return out;
}

/**
 * Normalize a rendered alignment string back to the raw keyword.
 *
 * The journal renderer maps raw values to decorated display strings:
 *   "bullish_all"      → "🟢🟢🟢 **all bullish**"
 *   "bullish_majority" → "🟢🟢 bullish majority"
 *   "bearish_all"      → "🔴🔴🔴 **all bearish**"
 *   "bearish_majority" → "🔴🔴 bearish majority"
 *   "mixed"            → "⚪ mixed"
 *
 * We reverse-map so the client can use strict keyword matching for the bias
 * badge. Keep this function in sync with the renderer in premarket_hsi.mjs.
 */
function normalizeAlignment(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const t = text.toLowerCase();
  if (/🟢🟢🟢/.test(text) || t.includes("all bullish")) return "bullish_all";
  if (/🔴🔴🔴/.test(text) || t.includes("all bearish")) return "bearish_all";
  if (t.includes("bullish majority") || /🟢🟢(?!🟢)/.test(text))
    return "bullish_majority";
  if (t.includes("bearish majority") || /🔴🔴(?!🔴)/.test(text))
    return "bearish_majority";
  if (t.includes("mixed") || /⚪/.test(text)) return "mixed";
  if (t.includes("unknown")) return "unknown";
  return text.trim();
}

function parseMTFBlock(block: string) {
  const align = block.match(/\*\*Alignment:\*\*\s*([^\n]+)/);
  const alignment = normalizeAlignment(align?.[1]);

  const key_levels: Array<{ type: string; price: number; tf: string }> = [];
  const levelRe =
    /- (swing high|swing low) @ \*\*([\d,.]+)\*\*\s*\(([^)]+)\)/g;
  let lm;
  while ((lm = levelRe.exec(block)) !== null) {
    const v = num(lm[2]);
    if (v != null) {
      key_levels.push({
        type: lm[1].includes("high") ? "high" : "low",
        price: v,
        tf: lm[3],
      });
    }
  }

  const fvg_zones: Array<{
    type: "bullish" | "bearish";
    low: number;
    high: number;
    tf: string;
  }> = [];
  const fvgRe =
    /- [^F]+(bullish|bearish) FVG:\s*([\d,.]+)\s*→\s*([\d,.]+)\s*\(([^)]+)\)/g;
  let fm;
  while ((fm = fvgRe.exec(block)) !== null) {
    const lo = num(fm[2]);
    const hi = num(fm[3]);
    if (lo != null && hi != null) {
      fvg_zones.push({
        type: fm[1] as "bullish" | "bearish",
        low: lo,
        high: hi,
        tf: fm[4],
      });
    }
  }

  return { alignment, key_levels, fvg_zones };
}

function parseORBBlock(block: string): ORBTrigger | undefined {
  // Block looks like:
  //   **HSI**: ORB 26179–26297 (range 118, 2.28× ATR)
  //     - Long  → entry 26297, stop 26179, T1 26415, T2 26533
  //     - Short → entry 26179, stop 26297, T1 26061, T2 25943
  const orbMatch = block.match(/ORB\s+([\d,.]+)[–-]([\d,.]+)\s*\(range\s+([\d,.]+)(?:,\s*([\d.]+)×\s*ATR)?/);
  if (!orbMatch) return undefined;

  const lowFromOrb = num(orbMatch[1]);
  const highFromOrb = num(orbMatch[2]);
  const range = num(orbMatch[3]);
  if (lowFromOrb == null || highFromOrb == null || range == null) return undefined;

  const longRe = /Long\s*→\s*entry\s*([\d,.]+),\s*stop\s*([\d,.]+),\s*T1\s*([\d,.]+),\s*T2\s*([\d,.]+)/;
  const shortRe = /Short\s*→\s*entry\s*([\d,.]+),\s*stop\s*([\d,.]+),\s*T1\s*([\d,.]+),\s*T2\s*([\d,.]+)/;
  const lm = block.match(longRe);
  const sm = block.match(shortRe);
  if (!lm || !sm) return undefined;

  return {
    orb_high: highFromOrb,
    orb_low: lowFromOrb,
    range,
    range_vs_atr: orbMatch[4] ? num(orbMatch[4]) : undefined,
    long: {
      entry: num(lm[1])!,
      stop: num(lm[2])!,
      T1: num(lm[3])!,
      T2: num(lm[4])!,
    },
    short: {
      entry: num(sm[1])!,
      stop: num(sm[2])!,
      T1: num(sm[3])!,
      T2: num(sm[4])!,
    },
  };
}

/**
 * Helper — collects all `### KEY` sub-blocks within a section into a map
 * keyed by lowercase KEY. Used for both Stage 1 (prior levels) and Stage 3
 * (multi-TF).
 */
function collectInstrumentBlocks(sectionBody: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Match every `### SOMETHING` header. Block extends until next ### or end.
  const blockRe = /### ([A-Za-z0-9_-]+)\n([\s\S]+?)(?=\n### |$)/g;
  let m;
  while ((m = blockRe.exec(sectionBody)) !== null) {
    out[m[1].toLowerCase()] = m[0];
  }
  return out;
}

function ensureInstrument(
  out: ParsedJournal,
  key: string
): MarketBlock {
  const lk = key.toLowerCase();
  if (!out.instruments[lk]) out.instruments[lk] = {};
  return out.instruments[lk];
}

export function parseJournal(md: string): ParsedJournal {
  const out: ParsedJournal = {
    date: null,
    generated_at: null,
    instruments: {},
  };

  // Title accepts both legacy "HSI Session" and new "Asia Session"
  const dateMatch = md.match(/^# (?:HSI|Asia) Session\s+—\s+(\S+)/m);
  if (dateMatch) out.date = dateMatch[1];
  const genMatch = md.match(/Generated by .+?at\s+(\S+)/);
  if (genMatch) out.generated_at = genMatch[1];

  // Stage 1 — Prior Session Levels (all `### KEY` headers inside the section)
  const stage1 = md.match(
    /## Stage 1 — Prior Session Levels([\s\S]+?)(?=\n## )/
  );
  if (stage1) {
    const blocks = collectInstrumentBlocks(stage1[1]);
    for (const [key, body] of Object.entries(blocks)) {
      ensureInstrument(out, key).levels = parseLevelsBlock(body);
    }
  }

  // Stage 3 — Multi-TF Analysis (same `### KEY` pattern)
  const stage3 = md.match(/## Stage 3 — Multi-TF Analysis([\s\S]+?)(?=\n## )/);
  if (stage3) {
    const blocks = collectInstrumentBlocks(stage3[1]);
    for (const [key, body] of Object.entries(blocks)) {
      ensureInstrument(out, key).mtf = parseMTFBlock(body);
    }
  }

  // Post-open ORB section — `**KEY**:` inline markers
  const orbSection = md.match(/## Post-open ORB[\s\S]+?$/);
  if (orbSection) {
    const orbRe = /\*\*([A-Za-z0-9_-]+)\*\*:[\s\S]+?(?=\n\n\*\*|$)/g;
    let om;
    while ((om = orbRe.exec(orbSection[0])) !== null) {
      const parsed = parseORBBlock(om[0]);
      if (parsed) ensureInstrument(out, om[1]).orb = parsed;
    }
  }

  // Pre-market verdict
  const verdict = md.match(/\*\*Pre-market verdict:\*\*\s*`([^`]+)`/);
  if (verdict) out.premarket_verdict = verdict[1];

  // Gates list
  const stage5 = md.match(/## Stage 5 — Gate Evaluation([\s\S]+?)(?=\n## )/);
  if (stage5) {
    const gates: Array<{ name: string; status: string }> = [];
    const gateRe = /- \*\*([^*]+)\*\*:\s*([^\n]+)/g;
    let gm;
    while ((gm = gateRe.exec(stage5[1])) !== null) {
      gates.push({ name: gm[1], status: gm[2] });
    }
    out.gates = gates;
  }

  return out;
}
