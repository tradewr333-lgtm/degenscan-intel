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
