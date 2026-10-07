/**
 * Micro-routes (ordem do vendedor 07/10, "Descoberta x402"): small, stable, cheap answers built for agent loops
 * (US$0.001–0.002, one small object, 60 s cache) — the shape that dominates x402 volume. The full tables stay on the
 * bigger routes and the subscriptions. Market data and analytics only — not a signal, not investment advice.
 */
import { getDb } from "../store/db.js";
import { ensureCarryTables, splitCoin, crossDex, spotPerp, HOUR, APR } from "../carry/hl.js";
import { brPremium, stablecoinSupply, treasuryAuctions } from "./macro.js";

export const MICRO_DISCLAIMER = "Market data only — not investment advice.";
const memo = new Map<string, { at: number; v: any }>();
function cached<T>(k: string, f: () => T | Promise<T>, ttl = 60_000): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return Promise.resolve(c.v as T);
  return Promise.resolve(f()).then(v => { memo.set(k, { at: Date.now(), v }); return v; });
}
const r4 = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000;

/** Normalise a coin id: main-dex coins upper-case (BTC), HIP-3 keep the dex prefix (xyz:NBIS). */
export function normCoin(raw: string) {
  const s = decodeURIComponent(String(raw ?? "")).trim();
  const i = s.indexOf(":");
  return i > 0 ? `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1).toUpperCase()}` : s.toUpperCase();
}

export function carryNow(coinRaw: string) {
  const coin = normCoin(coinRaw);
  return cached(`now:${coin}`, () => {
    ensureCarryTables(); const d = getDb();
    const last = d.prepare("SELECT ts, funding, mark, oracle, oi, vol24 FROM hl_funding WHERE coin = ? AND src = 'snapshot' ORDER BY ts DESC LIMIT 1").get(coin) as any;
    if (!last) return null;
    const avg = (h: number) => (d.prepare("SELECT AVG(funding) AS a FROM hl_funding WHERE coin = ? AND ts > ? AND ts <= ?").get(coin, last.ts - h * HOUR, last.ts) as any)?.a ?? null;
    const a8 = avg(8), a24 = avg(24);
    return { coin, dex: splitCoin(coin).dex, as_of: new Date(last.ts).toISOString(), funding_1h: last.funding,
      funding_apr: r4(last.funding == null ? null : APR(last.funding)), funding_apr_8h: r4(a8 == null ? null : APR(a8)), funding_apr_24h: r4(a24 == null ? null : APR(a24)),
      mark: last.mark, oracle: last.oracle, oi_usd: last.oi == null ? null : Math.round(last.oi), vol24_usd: last.vol24 == null ? null : Math.round(last.vol24), disclaimer: MICRO_DISCLAIMER };
  });
}

export function carryTop(nRaw: unknown) {
  const n = Math.min(Math.max(Number(nRaw) || 5, 1), 10);
  return cached(`top:${n}`, () => {
    const x = crossDex({ limit: n }); const s = spotPerp({ limit: n });
    return { as_of: x.as_of ?? s.as_of, n,
      xdex: (x.items as any[]).map(i => ({ base: i.base, legs: i.legs.map((l: any) => l.coin), spread_apr_now: i.spread_apr_now, spread_apr_14d: i.spread_apr_14d })),
      spot_perp: (s.items as any[]).map(i => ({ base: i.base, perp: i.perp, funding_apr: i.funding_apr, funding_apr_14d: i.funding_apr_14d, basis_pct: i.basis_pct })),
      disclaimer: MICRO_DISCLAIMER };
  });
}

export function carrySpread(raw: string) {
  const base = String(decodeURIComponent(raw ?? "")).trim().replace(/^[a-z0-9]+:/i, "").toUpperCase();
  return cached(`spread:${base}`, () => {
    const x = crossDex({ limit: 500, minVol: 0 });
    const it = (x.items as any[]).find(i => String(i.base).toUpperCase() === base);
    if (!it) return null;
    return { base, as_of: x.as_of, legs: it.legs.map((l: any) => ({ coin: l.coin, dex: l.dex, funding_apr: l.funding_apr, funding_apr_14d: l.funding_apr_14d })),
      spread_apr_now: it.spread_apr_now, spread_apr_14d: it.spread_apr_14d, basis_pct: it.basis_pct, disclaimer: MICRO_DISCLAIMER };
  });
}

export function hlMarkets() {
  return cached("markets", () => {
    ensureCarryTables();
    const rows = getDb().prepare("SELECT coin, dex, status FROM hl_markets ORDER BY dex, coin").all() as any[];
    const dexes: Record<string, string[]> = {};
    let delisted = 0;
    for (const r of rows) { if (r.status === "delisted") { delisted++; continue; } (dexes[r.dex] ??= []).push(r.coin); }
    return { as_of: new Date().toISOString(), active: Object.values(dexes).reduce((a, l) => a + l.length, 0), delisted, dexes, disclaimer: MICRO_DISCLAIMER };
  }, 10 * 60_000);
}

export function brPtax() {
  return cached("ptax", async () => {
    const b = await brPremium();
    return { as_of: b.as_of, ptax_usd_brl: b.ptax.usd_brl, ptax_date: b.ptax.date_ddmmyyyy, usdt_brl: b.crypto_dollar.usdt_brl,
      usdt_premium_vs_ptax_pct: b.crypto_dollar.usdt_premium_vs_ptax_pct, btc_premium_vs_ptax_pct: b.btc.premium_vs_ptax_pct, disclaimer: MICRO_DISCLAIMER };
  });
}

export function stablecoinsTotal() {
  return cached("stables", async () => {
    const s = await stablecoinSupply({ limit: 3 });
    return { as_of: s.as_of, circulating_usd: s.totals_usd_pegged.circulating, change_24h_usd: s.totals_usd_pegged.change_1d, change_7d_usd: s.totals_usd_pegged.change_7d,
      top3: s.items.map((i: any) => ({ symbol: i.symbol, circulating: i.circulating })), depegs: s.depegged_over_50bps.length, disclaimer: MICRO_DISCLAIMER };
  }, 5 * 60_000);
}

export function treasuryNext() {
  return cached("tsy", async () => {
    const t = await treasuryAuctions({ days: 7 });
    const next = t.upcoming.slice(0, 3);
    const last = t.results[0] ?? null;
    return { as_of: t.as_of, next, last_result: last ? { auction_date: last.auction_date, security_term: last.security_term, high_yield_pct: last.high_yield_pct ?? last.high_investment_rate_pct ?? last.high_discount_rate_pct, bid_to_cover: last.bid_to_cover } : null, disclaimer: MICRO_DISCLAIMER };
  }, 5 * 60_000);
}

/** Per-route latency ring buffer (last 500 responses per tool) → p50/p95 for the public trust block in /v1/metrics. */
const lat = new Map<string, number[]>();
export function noteLatency(tool: string, ms: number) { const a = lat.get(tool) ?? []; a.push(ms); if (a.length > 500) a.shift(); lat.set(tool, a); }
export function latencyStats() {
  const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]); };
  return Object.fromEntries([...lat.entries()].map(([t, a]) => [t, { n: a.length, p50_ms: q(a, 0.5), p95_ms: q(a, 0.95) }]));
}
