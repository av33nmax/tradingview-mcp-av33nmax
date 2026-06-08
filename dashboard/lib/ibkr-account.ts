/**
 * Dashboard ↔ IBKR account-data layer. Maintains a singleton TCP connection
 * to TWS (clientId 48) that survives Next.js dev hot-reloads via globalThis,
 * and exposes typed query functions for each account-data tab.
 *
 * Phase 4a part 1: getAccountSummary() only (read-only). Subsequent tabs
 * (positions, orders, executions) will add functions here.
 */
import {
  IBApi,
  EventName,
  type Contract,
  type Order,
  type OrderState,
  type Execution,
} from "@stoqey/ib";
import { IBKR_CONFIG, DASHBOARD_CLIENT_ID } from "./ibkr-config";

// ─── Singleton connection (survives Next dev hot-reload) ────────────────────
type IBHolder = {
  ib: IBApi | null;
  connected: boolean;
  connecting: Promise<IBApi> | null;
  // Callbacks to invoke on `disconnected` so any in-flight request can fail
  // immediately instead of waiting for its 10s timeout (during which more
  // polls pile up and IBKR accumulates leaked subscriptions on clientId 48,
  // eventually triggering error 322 "Maximum number of account summary
  // requests exceeded").
  onDisconnect: Set<() => void>;
};
const GLOBAL_KEY = "__crosshair_ib_account__";
const g = globalThis as unknown as Record<string, IBHolder>;
if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { ib: null, connected: false, connecting: null, onDisconnect: new Set() };
const holder = g[GLOBAL_KEY];
// Defensive: older holder objects on globalThis (from a Next.js hot-reload
// before this field existed) may not have `onDisconnect` — patch in place.
if (!holder.onDisconnect) holder.onDisconnect = new Set();

let nextReqId = 9000;

function setupHandlers(ib: IBApi) {
  ib.on(EventName.error, (err, code, reqId) => {
    const c = code as unknown as number; // ErrorCode enum is numeric-backed
    if (c >= 2100 && c <= 2200) return; // informational
    if (c === 200 || c === 300 || c === 354 || c === 2137) return;
    console.warn(`[ibkr-account] error code=${c} reqId=${reqId} ${err?.message || err}`);
  });
  ib.on(EventName.disconnected, () => {
    console.warn("[ibkr-account] disconnected from TWS");
    holder.connected = false;
    holder.ib = null;
    // Fail any in-flight requests fast so callers retry on reconnect rather
    // than sit on dead-socket timeouts that pile up subscriptions.
    const callbacks = [...holder.onDisconnect];
    holder.onDisconnect.clear();
    for (const cb of callbacks) {
      try { cb(); } catch { /* best effort */ }
    }
  });
}

async function ensureConnected(): Promise<IBApi> {
  if (holder.ib && holder.connected) return holder.ib;
  if (holder.connecting) return holder.connecting;

  holder.connecting = new Promise<IBApi>((resolve, reject) => {
    const ib = new IBApi({
      host: IBKR_CONFIG.host,
      port: IBKR_CONFIG.port,
      clientId: DASHBOARD_CLIENT_ID,
    });
    setupHandlers(ib);
    const timeout = setTimeout(() => {
      holder.connecting = null;
      reject(new Error(`IBKR connection timeout after 10s (host=${IBKR_CONFIG.host} port=${IBKR_CONFIG.port})`));
    }, 10000);
    const onConnected = () => {
      ib.off(EventName.connected, onConnected);
      clearTimeout(timeout);
      holder.ib = ib;
      holder.connected = true;
      holder.connecting = null;
      console.log(`[ibkr-account] connected to TWS at ${IBKR_CONFIG.host}:${IBKR_CONFIG.port} (clientId=${DASHBOARD_CLIENT_ID})`);
      resolve(ib);
    };
    ib.on(EventName.connected, onConnected);
    ib.connect();
  });

  return holder.connecting;
}

// ─── Account Summary query ──────────────────────────────────────────────────
// Note: RealizedPnL / UnrealizedPnL are NOT valid reqAccountSummary tags —
// IBKR silently drops unknown tags. P&L comes via reqPnL (separate API),
// see getAccountPnL() below. We merge those values into the summary response
// so the UI can read them under the same keys.
const ACCOUNT_SUMMARY_TAGS = [
  "NetLiquidation",
  "TotalCashValue",
  "AvailableFunds",
  "BuyingPower",
  "EquityWithLoanValue",
  "GrossPositionValue",
  "ExcessLiquidity",
  "Leverage",
  "MaintMarginReq",
  "InitMarginReq",
  "DayTradesRemaining",
  "AccruedCash",
];

export type AccountSummaryValue = { value: string; currency: string };
export type AccountSummary = {
  account: string;
  values: Record<string, AccountSummaryValue>;
  fetchedAt: number;
};

// ─── Coalescing + cache for getAccountSummary ───────────────────────────────
// Multiple components mount `useAccountSummary` (account-header on every
// page, account-summary-tab, day-pnl-tab) and each polls every 8s. Without
// coalescing, a render with N components issues N concurrent reqAccountSummary
// subscriptions on clientId 48 every 8s — IBKR caps these and after enough
// leaked-on-disconnect subscriptions, error 322 ("Maximum number of account
// summary requests exceeded") starts permanently rejecting requests.
//
// Strategy:
//   1. If a fresh cached value (< SUMMARY_TTL_MS old) exists, return it
//      immediately. Polls inside the TTL window do zero TWS work.
//   2. Else if a request is in-flight, return that same promise to all
//      concurrent callers (single TWS subscription, fan-out the result).
//   3. Else start a new request and update the cache when it lands.
// On TWS disconnect, the in-flight pending is rejected immediately rather
// than waiting 10s — see setupHandlers.
const SUMMARY_TTL_MS = 4000;
let cachedSummary: AccountSummary | null = null;
let cachedAt = 0;
let pendingSummary: Promise<AccountSummary> | null = null;

/**
 * One-shot fetch of the account summary. reqAccountSummary is a subscription;
 * we cancel as soon as accountSummaryEnd fires to keep this stateless.
 *
 * Concurrent callers and rapid polls share one in-flight request and a 4s
 * cache to avoid the IBKR error 322 subscription-leak storm.
 */
export async function getAccountSummary(): Promise<AccountSummary> {
  // Cache hit — bypass TWS entirely.
  if (cachedSummary && Date.now() - cachedAt < SUMMARY_TTL_MS) {
    return cachedSummary;
  }
  // Coalesce concurrent callers onto the same in-flight request.
  if (pendingSummary) return pendingSummary;

  pendingSummary = (async () => {
    try {
      const result = await fetchAccountSummaryFromTws();
      cachedSummary = result;
      cachedAt = Date.now();
      return result;
    } finally {
      pendingSummary = null;
    }
  })();
  return pendingSummary;
}

async function fetchAccountSummaryFromTws(): Promise<AccountSummary> {
  const ib = await ensureConnected();
  const reqId = nextReqId++;
  const values: Record<string, AccountSummaryValue> = {};
  let account = "";

  return new Promise<AccountSummary>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      ib.off(EventName.accountSummary, onSummary);
      ib.off(EventName.accountSummaryEnd, onEnd);
      holder.onDisconnect.delete(onDisconnect);
      try { ib.cancelAccountSummary(reqId); } catch { /* ignore */ }
      clearTimeout(timeout);
    };
    const onSummary = (
      id: number,
      acc: string,
      tag: string,
      value: string,
      currency: string,
    ) => {
      if (id !== reqId) return;
      account = acc;
      values[tag] = { value, currency };
    };
    const onEnd = (id: number) => {
      if (id !== reqId) return;
      cleanup();
      resolve({ account, values, fetchedAt: Date.now() });
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("account summary aborted: TWS disconnected"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("account summary timeout (10s)"));
    }, 10000);
    holder.onDisconnect.add(onDisconnect);
    ib.on(EventName.accountSummary, onSummary);
    ib.on(EventName.accountSummaryEnd, onEnd);
    ib.reqAccountSummary(reqId, "All", ACCOUNT_SUMMARY_TAGS.join(","));
  }).then(async (summary) => {
    // Augment with P&L from reqPnL (these are NOT valid reqAccountSummary
    // tags). Best-effort — if PnL fetch fails or times out, summary is
    // returned without those fields rather than failing the whole tab.
    if (!summary.account) return summary;
    try {
      const pnl = await getAccountPnL(summary.account);
      const ccy = summary.values["NetLiquidation"]?.currency ?? "USD";
      const fmt = (n: number) => n.toFixed(2);
      // IBKR sentinel for "not available" is Number.MAX_VALUE / very large;
      // treat anything above 1e15 as missing.
      const isReal = (n: unknown): n is number =>
        typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 1e15;
      if (isReal(pnl.realizedPnL)) summary.values["RealizedPnL"] = { value: fmt(pnl.realizedPnL), currency: ccy };
      if (isReal(pnl.unrealizedPnL)) summary.values["UnrealizedPnL"] = { value: fmt(pnl.unrealizedPnL), currency: ccy };
      if (isReal(pnl.dailyPnL)) summary.values["DailyPnL"] = { value: fmt(pnl.dailyPnL), currency: ccy };
    } catch (err) {
      console.warn(`[ibkr-account] getAccountPnL failed: ${err instanceof Error ? err.message : err}`);
    }
    return summary;
  });
}

// ─── P&L query (reqPnL — separate IBKR API from reqAccountSummary) ──────────
//
// reqPnL is a streaming subscription. We open it, capture one or two events
// (dailyPnL usually arrives first; realized/unrealized come in subsequent
// events), then cancel. Numbers come back in the account's base currency.
async function getAccountPnL(
  account: string,
  timeoutMs = 4000,
): Promise<{ dailyPnL?: number; unrealizedPnL?: number; realizedPnL?: number }> {
  const ib = await ensureConnected();
  const reqId = nextReqId++;

  return new Promise((resolve) => {
    const result: { dailyPnL?: number; unrealizedPnL?: number; realizedPnL?: number } = {};

    const onPnL = (
      id: number,
      dailyPnL: number,
      unrealizedPnL?: number,
      realizedPnL?: number,
    ) => {
      if (id !== reqId) return;
      result.dailyPnL = dailyPnL;
      if (unrealizedPnL != null) result.unrealizedPnL = unrealizedPnL;
      if (realizedPnL != null) result.realizedPnL = realizedPnL;
      // Resolve as soon as we have all three; otherwise the timeout
      // resolves with whatever arrived (typical IBKR behaviour: dailyPnL
      // alone in event 1, unrealized + realized in event 2).
      if (result.unrealizedPnL != null && result.realizedPnL != null) {
        cleanup();
        resolve(result);
      }
    };

    const cleanup = () => {
      ib.off(EventName.pnl, onPnL);
      try { ib.cancelPnL(reqId); } catch { /* ignore */ }
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(result);
    }, timeoutMs);

    ib.on(EventName.pnl, onPnL);
    ib.reqPnL(reqId, account, "");
  });
}

// ─── Positions query ────────────────────────────────────────────────────────
// IBKR API: ib.reqPositions() → multiple EventName.position(account,
// contract, pos, avgCost?) → EventName.positionEnd. cancelPositions()
// stops the subscription. We treat this as one-shot by cancelling on End.

export type PositionRow = {
  account: string;
  symbol: string;
  secType: string;
  expiry?: string;       // "YYYYMMDD" for options
  strike?: number;
  right?: string;        // "C" or "P" for options
  exchange?: string;
  currency?: string;
  conId?: number;
  position: number;      // negative = short
  avgCost: number;       // per-unit (per share for stocks; per option × 100 multiplier built in)
};

export async function getPositions(): Promise<PositionRow[]> {
  const ib = await ensureConnected();
  const rows: PositionRow[] = [];

  return new Promise<PositionRow[]>((resolve, reject) => {
    const onPos = (account: string, contract: Contract, pos: number, avgCost?: number) => {
      // Skip zero-position contracts (IBKR sometimes emits these for closed positions)
      if (pos === 0) return;
      rows.push({
        account,
        symbol: contract.symbol ?? "?",
        secType: contract.secType ?? "?",
        expiry: contract.lastTradeDateOrContractMonth,
        strike: contract.strike,
        right: contract.right,
        exchange: contract.exchange,
        currency: contract.currency,
        conId: contract.conId,
        position: pos,
        avgCost: avgCost ?? 0,
      });
    };
    const onEnd = () => {
      ib.off(EventName.position, onPos);
      ib.off(EventName.positionEnd, onEnd);
      try { ib.cancelPositions(); } catch { /* ignore */ }
      clearTimeout(timeout);
      resolve(rows);
    };
    const timeout = setTimeout(() => {
      ib.off(EventName.position, onPos);
      ib.off(EventName.positionEnd, onEnd);
      try { ib.cancelPositions(); } catch { /* ignore */ }
      reject(new Error("positions timeout (10s)"));
    }, 10000);
    ib.on(EventName.position, onPos);
    ib.on(EventName.positionEnd, onEnd);
    ib.reqPositions();
  });
}

// ─── Open orders query ──────────────────────────────────────────────────────
// IBKR API: reqAllOpenOrders() → multiple openOrder events + orderStatus
// events → openOrderEnd. We track orderId → row, merging openOrder + most
// recent orderStatus into a single record.

export type OrderRow = {
  orderId: number;
  permId?: number;
  symbol: string;
  secType: string;
  expiry?: string;
  strike?: number;
  right?: string;
  action: string;        // BUY | SELL
  orderType: string;     // MKT | LMT | STP | STP LMT
  qty: number;
  limitPrice?: number;
  auxPrice?: number;
  status: string;
  filled: number;
  remaining: number;
  avgFillPrice?: number;
  ocaGroup?: string;
};

export async function getOpenOrders(): Promise<OrderRow[]> {
  const ib = await ensureConnected();
  const orderMap = new Map<number, OrderRow>();

  return new Promise<OrderRow[]>((resolve, reject) => {
    const onOpenOrder = (orderId: number, contract: Contract, order: Order, orderState: OrderState) => {
      orderMap.set(orderId, {
        orderId,
        permId: order.permId,
        symbol: contract.symbol ?? "?",
        secType: contract.secType ?? "?",
        expiry: contract.lastTradeDateOrContractMonth,
        strike: contract.strike,
        right: contract.right,
        action: String(order.action ?? "?"),
        orderType: String(order.orderType ?? "?"),
        qty: Number(order.totalQuantity ?? 0),
        limitPrice: typeof order.lmtPrice === "number" ? order.lmtPrice : undefined,
        auxPrice: typeof order.auxPrice === "number" ? order.auxPrice : undefined,
        status: String(orderState.status ?? "?"),
        filled: 0,
        remaining: Number(order.totalQuantity ?? 0),
        ocaGroup: typeof order.ocaGroup === "string" ? order.ocaGroup : undefined,
      });
    };
    const onOrderStatus = (orderId: number, status: string, filled: number, remaining: number, avgFillPrice: number) => {
      const existing = orderMap.get(orderId);
      if (existing) {
        existing.status = status;
        existing.filled = Number(filled);
        existing.remaining = Number(remaining);
        if (Number.isFinite(avgFillPrice)) existing.avgFillPrice = avgFillPrice;
      }
    };
    const onEnd = () => {
      ib.off(EventName.openOrder, onOpenOrder);
      ib.off(EventName.orderStatus, onOrderStatus);
      ib.off(EventName.openOrderEnd, onEnd);
      clearTimeout(timeout);
      resolve([...orderMap.values()].sort((a, b) => a.orderId - b.orderId));
    };
    const timeout = setTimeout(() => {
      ib.off(EventName.openOrder, onOpenOrder);
      ib.off(EventName.orderStatus, onOrderStatus);
      ib.off(EventName.openOrderEnd, onEnd);
      reject(new Error("open orders timeout (10s)"));
    }, 10000);
    ib.on(EventName.openOrder, onOpenOrder);
    ib.on(EventName.orderStatus, onOrderStatus);
    ib.on(EventName.openOrderEnd, onEnd);
    ib.reqAllOpenOrders();
  });
}

// ─── Executions (today's fills) ─────────────────────────────────────────────
// IBKR API: reqExecutions(reqId, filter) → multiple execDetails events →
// execDetailsEnd. Default filter returns last 24h of executions; sufficient
// for "today's trades" since the dashboard date-rolls naturally.

export type ExecutionRow = {
  execId: string;
  orderId: number;
  permId?: number;
  symbol: string;
  secType: string;
  expiry?: string;
  strike?: number;
  right?: string;
  side: string;          // "BOT" | "SLD"
  qty: number;
  price: number;
  time: string;          // raw IBKR time string
  account: string;
  exchange?: string;
  currency?: string;     // contract currency: "USD", "HKD", ...
  multiplier?: number;   // contract multiplier (US options 100, HSI 50, stock 1)
};

export async function getExecutions(): Promise<ExecutionRow[]> {
  const ib = await ensureConnected();
  const reqId = nextReqId++;
  const rows: ExecutionRow[] = [];

  return new Promise<ExecutionRow[]>((resolve, reject) => {
    const onExec = (id: number, contract: Contract, execution: Execution) => {
      if (id !== reqId) return;
      rows.push({
        execId: String(execution.execId ?? "?"),
        orderId: Number(execution.orderId ?? 0),
        permId: execution.permId,
        symbol: contract.symbol ?? "?",
        secType: contract.secType ?? "?",
        expiry: contract.lastTradeDateOrContractMonth,
        strike: contract.strike,
        right: contract.right,
        side: String(execution.side ?? "?"),
        qty: Number(execution.shares ?? 0),
        price: Number(execution.price ?? 0),
        time: String(execution.time ?? ""),
        account: String(execution.acctNumber ?? ""),
        exchange: typeof execution.exchange === "string" ? execution.exchange : undefined,
        currency: typeof contract.currency === "string" ? contract.currency : undefined,
        multiplier:
          contract.multiplier != null && Number.isFinite(Number(contract.multiplier))
            ? Number(contract.multiplier)
            : undefined,
      });
    };
    const onEnd = (id: number) => {
      if (id !== reqId) return;
      ib.off(EventName.execDetails, onExec);
      ib.off(EventName.execDetailsEnd, onEnd);
      clearTimeout(timeout);
      // Sort newest-first
      rows.sort((a, b) => b.time.localeCompare(a.time));
      resolve(rows);
    };
    const timeout = setTimeout(() => {
      ib.off(EventName.execDetails, onExec);
      ib.off(EventName.execDetailsEnd, onEnd);
      reject(new Error("executions timeout (10s)"));
    }, 10000);
    ib.on(EventName.execDetails, onExec);
    ib.on(EventName.execDetailsEnd, onEnd);
    // Explicit time filter = "today 00:00 ET". Defaults to {} ("last 24h")
    // had a real-world failure 2026-04-30 where IBKR returned only post-
    // reconnect fills (a Next.js hot-reload mid-session cycled the singleton
    // TCP connection, dropping the in-memory execution buffer). The explicit
    // time filter forces IBKR to look up today's executions from its own
    // records, surviving connection cycles. Format: "yyyymmdd-HH:MM:SS".
    const todayET = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).format(new Date()).replace(/-/g, "");
    const filter = { time: `${todayET}-00:00:00` };
    ib.reqExecutions(reqId, filter as never);
  });
}

// ─── Per-currency balances ──────────────────────────────────────────────────
// IBKR API: reqAccountUpdates(true, account) streams updateAccountValue
// events → accountDownloadEnd. Each updateAccountValue is (key, value,
// currency, accountName). Per-currency cash balances surface as
// key="CashBalance" with currency = "USD"|"SGD"|"BASE"|... where "BASE" is
// the account's base currency duplicated.

export type BalanceRow = {
  currency: string;
  cashBalance: number;
};
export type BalancesResult = {
  account: string;
  baseCurrency: string;
  byCurrency: BalanceRow[];
  totalCashBase: number; // total cash in base currency
};

export async function getBalances(): Promise<BalancesResult> {
  const ib = await ensureConnected();
  // reqAccountUpdates needs an account code. We read it from a quick
  // accountSummary first if we don't have one cached.
  const summary = await getAccountSummary();
  const account = summary.account;
  if (!account) throw new Error("no account ID available for balances query");

  const cashByCurrency = new Map<string, number>();
  let baseCurrency = "USD";
  let totalCashBase = 0;

  return new Promise<BalancesResult>((resolve, reject) => {
    const onValue = (key: string, value: string, currency: string, acc: string) => {
      if (acc !== account) return;
      if (key === "CashBalance" && currency && currency !== "BASE") {
        const n = Number(value);
        if (Number.isFinite(n)) cashByCurrency.set(currency, n);
      } else if (key === "AccountCode" || key === "AccountType") {
        // ignore
      } else if (key === "Currency") {
        baseCurrency = value;
      } else if (key === "TotalCashValue" && currency === "BASE") {
        const n = Number(value);
        if (Number.isFinite(n)) totalCashBase = n;
      }
    };
    const onEnd = (acc: string) => {
      if (acc !== account) return;
      ib.off(EventName.updateAccountValue, onValue);
      ib.off(EventName.accountDownloadEnd, onEnd);
      try { ib.reqAccountUpdates(false, account); } catch { /* ignore */ }
      clearTimeout(timeout);
      const byCurrency: BalanceRow[] = [...cashByCurrency.entries()]
        .map(([currency, cashBalance]) => ({ currency, cashBalance }))
        .sort((a, b) => Math.abs(b.cashBalance) - Math.abs(a.cashBalance));
      resolve({ account, baseCurrency, byCurrency, totalCashBase });
    };
    const timeout = setTimeout(() => {
      ib.off(EventName.updateAccountValue, onValue);
      ib.off(EventName.accountDownloadEnd, onEnd);
      try { ib.reqAccountUpdates(false, account); } catch { /* ignore */ }
      reject(new Error("balances timeout (10s)"));
    }, 10000);
    ib.on(EventName.updateAccountValue, onValue);
    ib.on(EventName.accountDownloadEnd, onEnd);
    ib.reqAccountUpdates(true, account);
  });
}

// ─── Exchange rates (native currency → base) ────────────────────────────────
// IBKR emits updateAccountValue(key="ExchangeRate", value, currency) during
// reqAccountUpdates — the factor to convert `currency` into the account's base
// currency. Multiply a native amount by rates[ccy] to get the base-currency
// value. Rates move slowly, so cache for 60s and coalesce concurrent callers
// (Day P&L + Trade History both poll this) to avoid reqAccountUpdates churn.

export type ExchangeRates = {
  base: string;                    // account base currency (e.g. "SGD")
  rates: Record<string, number>;   // native ccy → base factor; base maps to 1
  fetchedAt: number;
};

const FX_TTL_MS = 60000;
let cachedFx: ExchangeRates | null = null;
let cachedFxAt = 0;
let pendingFx: Promise<ExchangeRates> | null = null;

export async function getExchangeRates(): Promise<ExchangeRates> {
  if (cachedFx && Date.now() - cachedFxAt < FX_TTL_MS) return cachedFx;
  if (pendingFx) return pendingFx;
  pendingFx = (async () => {
    try {
      const r = await fetchExchangeRatesFromTws();
      cachedFx = r;
      cachedFxAt = Date.now();
      return r;
    } finally {
      pendingFx = null;
    }
  })();
  return pendingFx;
}

async function fetchExchangeRatesFromTws(): Promise<ExchangeRates> {
  const ib = await ensureConnected();
  const summary = await getAccountSummary();
  const account = summary.account;
  if (!account) throw new Error("no account ID available for exchange rates query");

  const rates: Record<string, number> = {};
  let currencyHint = summary.values["NetLiquidation"]?.currency;

  return new Promise<ExchangeRates>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      ib.off(EventName.updateAccountValue, onValue);
      ib.off(EventName.accountDownloadEnd, onEnd);
      holder.onDisconnect.delete(onDisconnect);
      try { ib.reqAccountUpdates(false, account); } catch { /* ignore */ }
      clearTimeout(timeout);
    };
    const onValue = (key: string, value: string, currency: string, acc: string) => {
      if (acc !== account) return;
      if (key === "ExchangeRate") {
        const n = Number(value);
        if (currency && Number.isFinite(n) && n > 0) rates[currency] = n;
      } else if (key === "Currency" && value && value !== "BASE") {
        currencyHint = value;
      }
    };
    const onEnd = (acc: string) => {
      if (acc !== account) return;
      cleanup();
      // IBKR reports the base currency's own ExchangeRate as 1.0, plus a
      // synthetic "BASE" entry. The base is the real currency whose rate is
      // exactly 1.0 — more reliable than NetLiquidation.currency (which can
      // come back as USD even on an SGD-base account).
      delete rates["BASE"];
      let base = Object.keys(rates).find((c) => Math.abs(rates[c] - 1) < 1e-9);
      if (!base) base = currencyHint ?? "USD";
      if (rates[base] == null) rates[base] = 1;
      resolve({ base, rates, fetchedAt: Date.now() });
    };
    const onDisconnect = () => {
      cleanup();
      reject(new Error("exchange rates aborted: TWS disconnected"));
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("exchange rates timeout (10s)"));
    }, 10000);
    holder.onDisconnect.add(onDisconnect);
    ib.on(EventName.updateAccountValue, onValue);
    ib.on(EventName.accountDownloadEnd, onEnd);
    ib.reqAccountUpdates(true, account);
  });
}
