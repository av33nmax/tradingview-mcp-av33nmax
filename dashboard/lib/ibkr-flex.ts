/**
 * IBKR Flex Web Service — historical trade history straight from IBKR.
 *
 * The TWS socket API's reqExecutions is hard-capped at the CURRENT trading day,
 * so it cannot return prior-day trades. The Flex Web Service is IBKR's separate
 * reporting API that returns full trade history (months back) with no local
 * persistence. This module fetches a "Trades" Flex Query and maps each <Trade>
 * row into the same ExecutionRow shape the live path uses, so it flows through
 * the existing buildTrips() pipeline (currency, multiplier, SGD conversion).
 *
 * Setup (user, one-time, in IBKR Client Portal):
 *   Settings → Account Settings → Flex Web Service → enable, copy the TOKEN.
 *   Performance & Reports → Flex Queries → create an *Activity* Flex Query of
 *   section "Trades" (include underlyingSymbol, putCall, strike, expiry,
 *   multiplier, currency, ibExecID, buySell, quantity, tradePrice, dateTime).
 *   Copy the QUERY ID.
 * Then set in dashboard/.env.local:
 *   IBKR_FLEX_TOKEN=...
 *   IBKR_FLEX_QUERY_ID=...            # Activity query — settled history (T+1)
 *   IBKR_FLEX_CONFIRM_QUERY_ID=...    # optional: Trade Confirmation query — same-day fills
 *
 * If both queries are set, results are fetched and merged (deduped by execId),
 * so the Confirmation query closes the settle-lag gap where a just-done trade
 * has rolled off the live feed but hasn't settled into the Activity statement.
 *
 * Flex is rate-limited and statements generate asynchronously, so results are
 * cached aggressively (10 min) and concurrent callers are coalesced.
 */
import type { ExecutionRow } from "@/lib/ibkr-account";

const FLEX_BASE =
  "https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService";

export type FlexTradesResult = {
  executions: ExecutionRow[];
  fetchedAt: number;
};

const FLEX_TTL_MS = 10 * 60 * 1000; // 10 min — Flex is rate-limited
let cached: FlexTradesResult | null = null;
let cachedAt = 0;
let pending: Promise<FlexTradesResult> | null = null;

export function isFlexConfigured(): boolean {
  return Boolean(
    process.env.IBKR_FLEX_TOKEN &&
      (process.env.IBKR_FLEX_QUERY_ID || process.env.IBKR_FLEX_CONFIRM_QUERY_ID),
  );
}

export async function getFlexTrades(): Promise<FlexTradesResult> {
  if (cached && Date.now() - cachedAt < FLEX_TTL_MS) return cached;
  if (pending) return pending;
  pending = (async () => {
    try {
      const r = await fetchFlexTrades();
      cached = r;
      cachedAt = Date.now();
      return r;
    } finally {
      pending = null;
    }
  })();
  return pending;
}

async function fetchFlexTrades(): Promise<FlexTradesResult> {
  const token = process.env.IBKR_FLEX_TOKEN;
  if (!token) throw new Error("Flex not configured — set IBKR_FLEX_TOKEN in dashboard/.env.local");
  // Activity query = full settled history (T+1). Confirmation query = same-day
  // confirmed fills (near-real-time). Fetch whichever are set and merge.
  const queryIds = [process.env.IBKR_FLEX_QUERY_ID, process.env.IBKR_FLEX_CONFIRM_QUERY_ID]
    .filter((q): q is string => Boolean(q));
  if (queryIds.length === 0) {
    throw new Error("Flex not configured — set IBKR_FLEX_QUERY_ID and/or IBKR_FLEX_CONFIRM_QUERY_ID");
  }

  const byId = new Map<string, ExecutionRow>();
  const errors: string[] = [];
  for (const queryId of queryIds) {
    try {
      const xml = await fetchOneStatement(token, queryId);
      // Confirmation query runs after Activity (queryIds order), so its rows
      // win on execId — fine, it's the same trade from a fresher source.
      for (const e of parseFlexExecutions(xml)) byId.set(e.execId, e);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  // Only fail if EVERY query failed; a partial result still beats nothing.
  if (byId.size === 0 && errors.length) throw new Error(errors.join("; "));
  return { executions: [...byId.values()], fetchedAt: Date.now() };
}

/** Run the 2-step Flex flow for ONE query id and return the statement XML. */
async function fetchOneStatement(token: string, queryId: string): Promise<string> {
  // Step 1 — request statement generation, get a reference code.
  const sendUrl = `${FLEX_BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`;
  const sendXml = await fetchText(sendUrl);
  const sendStatus = pick(sendXml, "Status");
  if (sendStatus && sendStatus !== "Success") {
    throw new Error(`Flex SendRequest (q=${queryId}) ${sendStatus}: ${pick(sendXml, "ErrorMessage") ?? pick(sendXml, "ErrorCode") ?? "unknown"}`);
  }
  const referenceCode = pick(sendXml, "ReferenceCode");
  const baseUrl = pick(sendXml, "Url") ?? `${FLEX_BASE}/GetStatement`;
  if (!referenceCode) throw new Error(`Flex SendRequest (q=${queryId}) returned no ReferenceCode`);

  // Step 2 — poll GetStatement; IBKR generates async (ErrorCode 1019 = "in progress").
  const getUrl = `${baseUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const xml = await fetchText(getUrl);
    const code = pick(xml, "ErrorCode");
    if (code === "1019" || /generation in progress|please try again/i.test(xml)) {
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }
    const status = pick(xml, "Status");
    if (status && status !== "Success") {
      throw new Error(`Flex GetStatement (q=${queryId}) ${status}: ${pick(xml, "ErrorMessage") ?? code ?? "unknown"}`);
    }
    return xml;
  }
  throw new Error(`Flex statement (q=${queryId}) still generating after retries — will retry on next poll`);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Flex HTTP ${res.status} ${res.statusText}`);
  return res.text();
}

/** Pull the text of the first <Tag>...</Tag> occurrence. */
function pick(xml: string, tag: string): string | undefined {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`));
  return m ? m[1].trim() : undefined;
}

/**
 * Parse self-closing <Trade .../> (Activity query) AND <TradeConfirm .../>
 * (Trade Confirmation query) rows into ExecutionRow[]. The two report types
 * use slightly different attribute spellings, so accept both:
 *   exec id : ibExecID | execID | tradeID
 *   price   : tradePrice | price
 *   order   : ibOrderID | orderID
 */
function parseFlexExecutions(xml: string): ExecutionRow[] {
  const rows: ExecutionRow[] = [];
  const re = /<(?:TradeConfirm|Trade)\b([^>]*?)\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const a = parseAttrs(m[1]);
    const secType = a.assetCategory || "STK";
    // FX conversions surface as CASH — skip, like the live path does.
    if (secType === "CASH") continue;
    const execId = a.ibExecID || a.execID || a.tradeID;
    if (!execId) continue;
    const buySell = (a.buySell || "").toUpperCase();
    const orderIdRaw = a.ibOrderID || a.orderID;
    rows.push({
      execId,
      orderId: orderIdRaw ? Number(orderIdRaw) || 0 : 0,
      symbol: a.underlyingSymbol || a.symbol || "?",
      secType,
      expiry: a.expiry || undefined,
      strike: a.strike ? Number(a.strike) : undefined,
      right: a.putCall || undefined,
      side: buySell.startsWith("B") ? "BOT" : "SLD",
      qty: Math.abs(Number(a.quantity) || 0),
      price: Number(a.tradePrice ?? a.price) || 0,
      time: flexTime(a.dateTime, a.tradeDate),
      account: a.accountId || "",
      exchange: a.exchange || undefined,
      currency: a.currency || undefined,
      multiplier:
        a.multiplier != null && Number.isFinite(Number(a.multiplier))
          ? Number(a.multiplier)
          : undefined,
    });
  }
  return rows;
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]] = decodeXml(m[2]);
  return out;
}

function decodeXml(v: string): string {
  return v
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * Normalize Flex dateTime to the live path's "YYYYMMDD HH:MM:SS" format so
 * round-trips.ts parseTime() / dateETFromTime() work unchanged. Flex emits
 * "20260526;130405" or "20260526;13:04:05" depending on query config.
 */
function flexTime(dateTime?: string, tradeDate?: string): string {
  if (dateTime && dateTime.includes(";")) {
    const [d, rawT] = dateTime.split(";");
    const t = (rawT || "").replace(/\D/g, "").padEnd(6, "0").slice(0, 6);
    return `${d} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
  }
  if (dateTime && /^\d{8}$/.test(dateTime)) return `${dateTime} 00:00:00`;
  if (tradeDate && /^\d{8}$/.test(tradeDate)) return `${tradeDate} 00:00:00`;
  return dateTime || tradeDate || "";
}
