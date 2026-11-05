/**
 * deribit_perps (05/11, Renato — Milk Road post: Coinbase for Agents + Champions Cup 04–25/11 run on Deribit perps).
 * Coinbase's international derivatives (Coinbase Advanced / Coinbase for Agents, outside the U.S.) are executed on Deribit
 * since INTX perps ended on 01/10/2026. Source: Deribit's public market-data API (no key), same as options_summary.
 * Derived numbers per perpetual: funding 8 h and annualised, premium of mark over index (bp), open interest in USD,
 * 24 h volume, and the funding gap vs Hyperliquid for the same coin. One symbol adds 7 days of hourly funding history.
 * Not affiliated with Coinbase or Deribit. Information and analytics only — not investment advice.
 */
import { UA } from "../ingest/http.js";

const DERIBIT = process.env.DERIBIT_URL ?? "https://www.deribit.com/api/v2";
export const DP_DISCLAIMER = "Derived from Deribit public market data. Not affiliated with Coinbase or Deribit. Information and analytics only — not investment advice.";
const memo = new Map<string, { at: number; v: any }>();
export const _dp = { reset() { memo.clear(); }, fetch: (u: string) => fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }), hl: async () => (await import("./tools.js")).hlFundingMap() };
async function get(path: string, ttl: number) {
  const c = memo.get(path); if (c && Date.now() - c.at < ttl) return c.v;
  try {
    const res = await _dp.fetch(`${DERIBIT}${path}`);
    if (!res.ok) throw Object.assign(new Error(`deribit ${res.status}`), { status: 502 });
    const j: any = await res.json(); if (j?.error) throw Object.assign(new Error(`deribit ${j.error.message ?? "error"}`), { status: 502 });
    memo.set(path, { at: Date.now(), v: j.result }); return j.result;
  } catch (e) { if (c) return c.v; throw e; }
}
const num = (x: any) => x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x);
const rd = (x: number | null, d = 4) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;

/** "SOL_USDC-PERPETUAL" → "SOL"; "BTC-PERPETUAL" → "BTC". */
export function perpSymbol(name: string) { const m = /^([A-Z0-9]+?)(?:_(USDC|USDT))?-PERPETUAL$/.exec(String(name)); return m ? m[1] : null; }

/** Pure: Deribit book summaries (any currency, kind=future) → one row per perpetual. Exported for tests. */
export function perpRows(rows: any[], hl?: Map<string, number>) {
  return (rows ?? []).filter(x => /-PERPETUAL$/.test(String(x?.instrument_name))).map(x => {
    const sym = perpSymbol(x.instrument_name)!; const inverse = !/_/.test(x.instrument_name);
    const mark = num(x.mark_price), idx = num(x.estimated_delivery_price), f8 = num(x.funding_8h), oi = num(x.open_interest);
    const hl1h = hl?.get(sym) ?? hl?.get(sym.replace(/^1000/, "K")) ?? null;
    const apr = f8 != null ? f8 * 3 * 365 * 100 : null, hlApr = hl1h != null ? hl1h * 24 * 365 * 100 : null;
    return { symbol: sym, instrument: x.instrument_name, margin: inverse ? "inverse (coin-margined)" : "linear (USDC)", mark_price: mark, index_price: idx,
      premium_bp: mark != null && idx ? rd((mark / idx - 1) * 1e4, 2) : null,
      funding_8h_pct: f8 != null ? rd(f8 * 100, 5) : null, funding_apr_pct: rd(apr, 2), current_funding_pct: num(x.current_funding) != null ? rd(Number(x.current_funding) * 100, 5) : null,
      open_interest_usd: oi == null ? null : Math.round(inverse ? oi : oi * (mark ?? 0)), volume_24h_usd: num(x.volume_usd) != null ? Math.round(Number(x.volume_usd)) : null,
      hyperliquid_funding_apr_pct: rd(hlApr, 2), funding_gap_vs_hyperliquid_apr_pct: apr != null && hlApr != null ? rd(apr - hlApr, 2) : null };
  });
}
const SORTS: Record<string, (r: any) => number> = { volume: r => r.volume_24h_usd ?? 0, oi: r => r.open_interest_usd ?? 0, funding: r => r.funding_apr_pct ?? -1e9, neg_funding: r => -(r.funding_apr_pct ?? 1e9), abs_funding: r => Math.abs(r.funding_apr_pct ?? 0), gap: r => Math.abs(r.funding_gap_vs_hyperliquid_apr_pct ?? 0) };

/** Pure: hourly funding history → 24 h / 7 d sums and APRs. Exported for tests. */
export function historyStats(h: any[]) {
  const rows = (h ?? []).filter(x => Number.isFinite(Number(x?.interest_1h))).sort((a, b) => a.timestamp - b.timestamp);
  const sum = (n: number) => rows.slice(-n).reduce((a, x) => a + Number(x.interest_1h), 0);
  const per = (n: number) => rows.length >= n ? { paid_pct: rd(sum(n) * 100, 4), apr_pct: rd(sum(n) / n * 24 * 365 * 100, 2) } : null;
  return { hours: rows.length, last_24h: per(24), last_7d: per(168), positive_hours_pct: rows.length ? rd(rows.filter(x => Number(x.interest_1h) > 0).length / rows.length * 100, 1) : null,
    hourly: rows.slice(-48).map(x => ({ t: new Date(x.timestamp).toISOString(), funding_1h_pct: rd(Number(x.interest_1h) * 100, 5) })) };
}

export async function deribitPerps(a: any = {}) {
  const [btc, eth, usdc] = await Promise.all(["BTC", "ETH", "USDC"].map(c => get(`/public/get_book_summary_by_currency?currency=${c}&kind=future`, 30_000).catch(() => [])));
  const hl = await _dp.hl().catch(() => undefined);
  let rows = perpRows([...btc, ...eth, ...usdc], hl);
  if (!rows.length) throw Object.assign(new Error("Deribit market data unavailable"), { status: 502 });
  const want = String(a.symbols ?? a.symbol ?? a.coin ?? "").toUpperCase().split(/[,\s]+/).filter(Boolean).slice(0, 20);
  if (want.length) rows = rows.filter(r => want.includes(r.symbol));
  if (a.min_volume_usd != null) rows = rows.filter(r => (r.volume_24h_usd ?? 0) >= Number(a.min_volume_usd));
  const sort = SORTS[String(a.sort)] ? String(a.sort) : "volume";
  rows.sort((x, y) => SORTS[sort](y) - SORTS[sort](x));
  const limit = Math.min(Math.max(Number(a.limit) || 25, 1), 150);
  let history: any = undefined;
  if (want.length === 1 && rows.length) {
    const inst = rows.find(r => r.margin.startsWith("linear"))?.instrument ?? rows[0].instrument, now = Date.now();
    history = { instrument: inst, ...historyStats(await get(`/public/get_funding_rate_history?instrument_name=${encodeURIComponent(inst)}&start_timestamp=${now - 7 * 86_400_000}&end_timestamp=${now}`, 300_000).catch(() => [])) };
  }
  return { venue: "Deribit (venue for Coinbase Advanced international perpetuals)", count: Math.min(rows.length, limit), sort, items: rows.slice(0, limit), ...(history ? { funding_history: history } : {}),
    method: "funding_apr = funding_8h × 3 × 365; Hyperliquid APR = hourly funding × 24 × 365 (positive: longs pay shorts). premium_bp = mark ÷ index − 1. Inverse perps report OI in USD; linear OI = contracts × mark.",
    sources: ["Deribit public API (get_book_summary_by_currency, get_funding_rate_history)", "Hyperliquid info API (metaAndAssetCtxs)"], as_of: new Date().toISOString(), disclaimer: DP_DISCLAIMER };
}
