/**
 * Réplicas do x402-scout (Renato 28/10): two product types that sell on the Bazaar, rebuilt from OUR primary
 * sources — never another seller's data — at half their price.
 *  - gas_base  (/v1/gas/base): Base gas now — base fee, priority-fee percentiles, suggested EIP-1559 fees, cost of a
 *    transfer / ERC-20 transfer / swap in ETH and USD. Source: Base public RPC (eth_feeHistory) + Coinbase ETH spot.
 *  - hl_basis  (/v1/hl/basis/:coin): Hyperliquid perp premium (mark vs oracle, impact premium), funding now and
 *    24h/7d mean from our own hourly history, and predicted funding on Hyperliquid, Binance and Bybit
 *    (Hyperliquid's public predictedFundings). Source: Hyperliquid info API + our hl_funding table.
 * Market data only — not investment advice.
 */
import { info, ensureCarryTables, HOUR, APR } from "../carry/hl.js";
import { getDb } from "../store/db.js";
import { UA } from "../ingest/http.js";

export const REP_DISCLAIMER = "Market data only — not investment advice.";
const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const memo = new Map<string, { at: number; v: any }>();
async function cached<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  const v = await f(); memo.set(k, { at: Date.now(), v }); return v;
}
export const _rep = { reset() { memo.clear(); } };
const r = (x: number | null | undefined, d = 4) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;

async function rpc<T = any>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(BASE_RPC, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`base rpc ${res.status}`);
  const j: any = await res.json(); if (j?.error) throw new Error(`base rpc ${j.error.message ?? "error"}`);
  return j.result as T;
}
async function ethUsd(): Promise<number | null> {
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/ETH-USD/spot", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(5000) });
    const j: any = await res.json(); const p = Number(j?.data?.amount); return Number.isFinite(p) && p > 0 ? p : null;
  } catch { return null; }
}

const hex = (h: string) => Number(BigInt(h));
/** Pure: feeHistory (wei hex) → gwei summary. Exported for tests. */
export function gasFromHistory(fh: { baseFeePerGas: string[]; reward?: string[][]; oldestBlock: string; gasUsedRatio?: number[] }, eth: number | null) {
  const bases = fh.baseFeePerGas.map(hex); const next = bases[bases.length - 1]; const last = bases[bases.length - 2] ?? next;
  const col = (i: number) => { const v = (fh.reward ?? []).map(x => hex(x[i] ?? "0x0")).sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  const pr = { low: col(0), medium: col(1), high: col(2) };
  const g = (wei: number) => r(wei / 1e9, 6)!;
  const sug = (p: number) => ({ max_priority_fee_gwei: g(p), max_fee_gwei: g(next * 2 + p) });
  const cost = (units: number) => { const wei = units * (next + pr.medium); const ethc = wei / 1e18; return { gas_units: units, eth: r(ethc, 9), usd: eth ? r(ethc * eth, 6) : null }; };
  const ratios = fh.gasUsedRatio ?? [];
  return {
    chain: "base", chain_id: 8453, block: hex(fh.oldestBlock) + bases.length - 2,
    base_fee_gwei: g(last), next_base_fee_gwei: g(next),
    base_fee_trend_pct: bases[0] ? r((next - bases[0]) / bases[0] * 100, 2) : null,
    priority_fee_gwei: { p10: g(pr.low), p50: g(pr.medium), p90: g(pr.high) },
    suggested: { low: sug(pr.low), medium: sug(pr.medium), high: sug(pr.high) },
    block_fullness_pct: ratios.length ? r(ratios.reduce((a, x) => a + x, 0) / ratios.length * 100, 1) : null,
    l2_execution_cost: { eth_transfer: cost(21_000), erc20_transfer: cost(65_000), dex_swap: cost(180_000) },
    eth_usd: eth, window_blocks: bases.length - 1,
    note: "L2 execution fee only; Base also charges a small L1 data fee that depends on calldata size.",
  };
}

export function gasBase() {
  return cached("gas:base", 15_000, async () => {
    const [fh, eth] = await Promise.all([rpc<any>("eth_feeHistory", ["0x14", "latest", [10, 50, 90]]), ethUsd()]);
    return { ...gasFromHistory(fh, eth), as_of: new Date().toISOString(), sources: ["Base public RPC eth_feeHistory", "Coinbase ETH-USD spot"], disclaimer: REP_DISCLAIMER };
  });
}

const VENUE: Record<string, string> = { HlPerp: "hyperliquid", BinPerp: "binance", BybitPerp: "bybit" };
/** Pure: Hyperliquid ctx + predictedFundings row → basis object. Exported for tests. */
export function basisFrom(coin: string, ctx: any, pred: any[] | null, hist: { a24: number | null; a7d: number | null; pos7d: number | null }) {
  const mark = Number(ctx.markPx), oracle = Number(ctx.oraclePx), mid = ctx.midPx != null ? Number(ctx.midPx) : null;
  const f = Number(ctx.funding);
  const [ib, ia] = (ctx.impactPxs ?? []).map(Number);
  return {
    coin, mark, oracle, mid,
    mark_oracle_premium_bps: oracle ? r((mark - oracle) / oracle * 1e4, 2) : null,
    impact_premium_bps: ctx.premium != null ? r(Number(ctx.premium) * 1e4, 2) : null,
    impact_spread_bps: ib && ia && mid ? r((ia - ib) / mid * 1e4, 2) : null,
    funding: { hourly: f, per_8h: r(f * 8, 8), apr_pct: r(APR(f) * 100, 2),
      apr_24h_mean_pct: hist.a24 == null ? null : r(APR(hist.a24) * 100, 2), apr_7d_mean_pct: hist.a7d == null ? null : r(APR(hist.a7d) * 100, 2),
      positive_share_7d_pct: hist.pos7d },
    predicted_funding: (pred ?? []).filter((v: any) => v?.[1]).map(([venue, v]: any) => {
      const h = Number(v.fundingIntervalHours ?? (venue === "HlPerp" ? 1 : 8)); const rate = Number(v.fundingRate);
      return { venue: VENUE[venue] ?? venue, rate, interval_hours: h, per_8h: r(rate / h * 8, 8), apr_pct: r(rate / h * 24 * 365 * 100, 2),
        next_funding: v.nextFundingTime ? new Date(Number(v.nextFundingTime)).toISOString() : null };
    }),
    open_interest_usd: Number.isFinite(Number(ctx.openInterest)) ? Math.round(Number(ctx.openInterest) * mark) : null,
    volume_24h_usd: ctx.dayNtlVlm != null ? Math.round(Number(ctx.dayNtlVlm)) : null,
  };
}

function history(coin: string) {
  try {
    ensureCarryTables(); const d = getDb(); const now = Date.now();
    const a = (h: number) => (d.prepare("SELECT AVG(funding) AS a FROM hl_funding WHERE coin = ? AND ts > ?").get(coin, now - h * HOUR) as any)?.a ?? null;
    const p = d.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN funding > 0 THEN 1 ELSE 0 END) AS pos FROM hl_funding WHERE coin = ? AND ts > ?").get(coin, now - 168 * HOUR) as any;
    return { a24: a(24), a7d: a(168), pos7d: p?.n ? r(p.pos / p.n * 100, 1) : null };
  } catch { return { a24: null, a7d: null, pos7d: null }; }
}

export async function hlBasis(raw: string) {
  const coin = String(decodeURIComponent(raw ?? "")).trim().toUpperCase().replace(/-PERP$|USDT?$|USDC$|-USD$/, "");
  if (!/^[A-Z0-9]{1,15}$/.test(coin)) throw Object.assign(new Error("main-dex coin, e.g. BTC, ETH, HYPE"), { status: 400 });
  return cached(`basis:${coin}`, 30_000, async () => {
    const [mc, pf] = await Promise.all([
      cached("hl:mac", 30_000, () => info<any>({ type: "metaAndAssetCtxs" })),
      cached("hl:pred", 60_000, () => info<any>({ type: "predictedFundings" })).catch(() => null),
    ]);
    const i = (mc?.[0]?.universe ?? []).findIndex((u: any) => String(u.name).toUpperCase() === coin);
    if (i < 0 || !mc?.[1]?.[i]) return null;
    const pred = (pf as any[] | null)?.find((x: any) => String(x?.[0]).toUpperCase() === coin)?.[1] ?? null;
    return { ...basisFrom(coin, mc[1][i], pred, history(coin)), as_of: new Date().toISOString(),
      sources: ["Hyperliquid info API (metaAndAssetCtxs, predictedFundings)", "Degenscan hourly funding history"], disclaimer: REP_DISCLAIMER };
  });
}

// ── Réplicas da fila (relatório 48 h, 29/10) ─────────────────────────────────────────────────────────────
const INTERVALS: Record<string, number> = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000 };
/** Pure: Hyperliquid candleSnapshot rows → OHLCV + summary. Exported for tests. */
export function candlesFrom(coin: string, interval: string, rows: any[]) {
  const c = (rows ?? []).map(x => ({ t: new Date(Number(x.t)).toISOString(), o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c), v: Number(x.v), trades: Number(x.n) || 0 }))
    .filter(x => Number.isFinite(x.c));
  if (!c.length) return null;
  const first = c[0], last = c[c.length - 1];
  const hi = Math.max(...c.map(x => x.h)), lo = Math.min(...c.map(x => x.l));
  const vol = c.reduce((a, x) => a + x.v, 0); const vwap = vol ? c.reduce((a, x) => a + x.v * (x.h + x.l + x.c) / 3, 0) / vol : null;
  return { coin, interval, n: c.length, from: first.t, to: last.t,
    summary: { open: first.o, close: last.c, change_pct: first.o ? r((last.c - first.o) / first.o * 100, 3) : null, high: hi, low: lo,
      range_pct: lo ? r((hi - lo) / lo * 100, 3) : null, volume_base: r(vol, 4), vwap: vwap == null ? null : r(vwap, 6) },
    candles: c };
}
export async function hlCandles(raw: string, intervalRaw?: unknown, limitRaw?: unknown) {
  const s = String(decodeURIComponent(raw ?? "")).trim(); const i = s.indexOf(":");
  const coin = i > 0 ? `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1).toUpperCase()}` : s.toUpperCase().replace(/-PERP$|USDT?$|USDC$|-USD$/, "");
  if (!/^([a-z0-9]{1,10}:)?[A-Z0-9]{1,15}$/.test(coin)) throw Object.assign(new Error("coin like BTC, ETH, HYPE or xyz:NBIS"), { status: 400 });
  const interval = String(intervalRaw ?? "1h").toLowerCase(); const ms = INTERVALS[interval];
  if (!ms) throw Object.assign(new Error(`interval one of ${Object.keys(INTERVALS).join(", ")}`), { status: 400 });
  const limit = Math.min(Math.max(Number(limitRaw) || 100, 1), 500);
  return cached(`cdl:${coin}:${interval}:${limit}`, Math.min(ms / 2, 60_000), async () => {
    const end = Date.now(); const rows = await info<any[]>({ type: "candleSnapshot", req: { coin, interval, startTime: end - ms * limit, endTime: end } });
    const o = candlesFrom(coin, interval, (rows ?? []).slice(-limit)); if (!o) return null;
    return { ...o, as_of: new Date(end).toISOString(), source: "Hyperliquid info API (candleSnapshot)", disclaimer: REP_DISCLAIMER };
  });
}

const PM_PERIOD: Record<string, string> = { day: "DAY", week: "WEEK", month: "MONTH", all: "ALL" };
/** Pure: Polymarket data-api leaderboard rows → compact list. Exported for tests. */
export function leaderboardFrom(rows: any[]) {
  return (rows ?? []).map((x: any) => ({ rank: Number(x.rank), wallet: String(x.proxyWallet ?? ""), name: x.userName && !/^0x[0-9a-f]{40}-\d+$/i.test(x.userName) ? String(x.userName) : null,
    pnl_usd: r(Number(x.pnl), 2), volume_usd: r(Number(x.vol), 2), pnl_to_volume_pct: Number(x.vol) > 0 ? r(Number(x.pnl) / Number(x.vol) * 100, 2) : null }))
    .filter(x => x.wallet && Number.isFinite(x.rank));
}
export async function polymarketLeaderboard(periodRaw?: unknown, byRaw?: unknown, limitRaw?: unknown) {
  const period = PM_PERIOD[String(periodRaw ?? "week").toLowerCase()]; if (!period) throw Object.assign(new Error("period one of day, week, month, all"), { status: 400 });
  const by = String(byRaw ?? "pnl").toLowerCase() === "volume" ? "VOL" : "PNL";
  const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 50);
  return cached(`pmlb:${period}:${by}:${limit}`, 300_000, async () => {
    const res = await fetch(`https://data-api.polymarket.com/v1/leaderboard?timePeriod=${period}&orderBy=${by}&limit=${limit}`, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`polymarket ${res.status}`);
    const items = leaderboardFrom(await res.json());
    return { period: period.toLowerCase(), order_by: by === "VOL" ? "volume" : "pnl", n: items.length, items, as_of: new Date().toISOString(),
      source: "Polymarket public data API (leaderboard)", disclaimer: REP_DISCLAIMER };
  });
}

// ── Base balance (réplica onesource erc20-balance / live-balance: 412 e 338 compradores a US$ 0,003) ─────────
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const word = (a: string) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** Pure: decode an ABI string/bytes32 return (symbol()). Exported for tests. */
export function abiString(hexRet: string | null | undefined): string | null {
  const h = String(hexRet ?? "").replace(/^0x/, ""); if (!h) return null;
  try {
    if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "") || null;
    const len = parseInt(h.slice(64, 128), 16); return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8") || null;
  } catch { return null; }
}
export async function baseBalance(addrRaw: string, tokenRaw?: unknown) {
  const addr = String(addrRaw ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) throw Object.assign(new Error("address must be 0x + 40 hex"), { status: 400 });
  const token = tokenRaw ? String(tokenRaw).trim().toLowerCase() : null;
  if (token && !/^0x[0-9a-f]{40}$/.test(token)) throw Object.assign(new Error("token must be 0x + 40 hex"), { status: 400 });
  return cached(`bal:${addr}:${token}`, 10_000, async () => {
    const call = (to: string, data: string) => rpc<string>("eth_call", [{ to, data }, "latest"]);
    const bal = (t: string) => call(t, "0x70a08231" + word(addr));
    const [eth, usdc, block, tb, td, ts] = await Promise.all([
      rpc<string>("eth_getBalance", [addr, "latest"]), bal(USDC_BASE), rpc<string>("eth_blockNumber", []),
      token ? bal(token) : Promise.resolve(null), token ? call(token, "0x313ce567").catch(() => null) : Promise.resolve(null),
      token ? call(token, "0x95d89b41").catch(() => null) : Promise.resolve(null)]);
    const dec = td ? Number(BigInt(td)) : 18;
    const fmt = (v: string | null, d: number) => v == null || v === "0x" ? null : Number(BigInt(v)) / 10 ** d;
    return { chain: "base", chain_id: 8453, address: addr, block: Number(BigInt(block)),
      eth: fmt(eth, 18), usdc: fmt(usdc, 6),
      token: token ? { address: token, symbol: abiString(ts), decimals: dec, balance: fmt(tb, dec) } : null,
      as_of: new Date().toISOString(), source: "Base public RPC (eth_getBalance, balanceOf)", disclaimer: REP_DISCLAIMER };
  });
}
