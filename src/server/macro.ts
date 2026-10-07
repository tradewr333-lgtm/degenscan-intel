/**
 * Lote "public-apis" (Renato 06/10): four new data routes built on free, public, keyless primary sources whose terms allow
 * derived/commercial use. We never proxy a third-party API 1:1 — each route normalizes, joins and adds the computed fields.
 *   br_premium        Mercado Bitcoin (BTC-BRL, USDT-BRL, USDC-BRL) × BCB PTAX (SGS 1) × Coinbase BTC-USD → crypto-dollar and BTC premium in Brazil
 *   stablecoin_supply DefiLlama stablecoins → circulating supply and 1d/7d/30d change per stablecoin and in total
 *   treasury_auctions U.S. Treasury Fiscal Data (public domain) → recent results (high yield, bid-to-cover, bidder split) + upcoming auctions
 *   defi_yields       DefiLlama yields → stablecoin/single-asset pools above a TVL floor, with 30d mean APY and outlier flag
 * Information and analytics only — not investment advice.
 */
import { fetchJson } from "../ingest/http.js";

const cache = new Map<string, { at: number; v: any }>();
async function memo<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const c = cache.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  try { const v = await f(); cache.set(k, { at: Date.now(), v }); return v; }
  catch (e) { if (c) return c.v as T; throw e; }            // stale-on-error: keep serving the last good copy
}
const n = (x: unknown) => { const v = Number(x); return Number.isFinite(v) ? v : null; };
const r = (x: number | null, d = 4) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
const pctOf = (a: number | null, b: number | null) => a != null && b ? r((a / b - 1) * 100, 3) : null;
export const MACRO_DISCLAIMER = "Market data and analytics only — not investment advice. Informação e análise, não é recomendação de investimento.";

// ───────────────────────── Brazil premium
export async function brPremium() {
  const [mb, ptaxRows, cb] = await Promise.all([
    memo("mb", 30_000, () => fetchJson<any[]>("https://api.mercadobitcoin.net/api/v4/tickers?symbols=BTC-BRL,USDT-BRL,USDC-BRL", { timeoutMs: 8000 })),
    memo("ptax", 3_600_000, () => fetchJson<any[]>("https://api.bcb.gov.br/dados/serie/bcdata.sgs.1/dados/ultimos/1?formato=json", { timeoutMs: 8000 })),
    memo("cb:BTC", 30_000, () => fetchJson<any>("https://api.coinbase.com/v2/prices/BTC-USD/spot", { timeoutMs: 6000 })),
  ]);
  const t = (p: string) => mb.find((x: any) => x.pair === p);
  const btcBrl = n(t("BTC-BRL")?.last), usdtBrl = n(t("USDT-BRL")?.last), usdcBrl = n(t("USDC-BRL")?.last);
  const ptax = n(ptaxRows?.[0]?.valor), ptaxDate = ptaxRows?.[0]?.data ?? null, btcUsd = n(cb?.data?.amount);
  return {
    as_of: new Date().toISOString(),
    ptax: { usd_brl: ptax, date_ddmmyyyy: ptaxDate, source: "Banco Central do Brasil, SGS série 1 (PTAX venda, diária)" },
    crypto_dollar: {
      usdt_brl: usdtBrl, usdc_brl: usdcBrl,
      usdt_premium_vs_ptax_pct: pctOf(usdtBrl, ptax), usdc_premium_vs_ptax_pct: pctOf(usdcBrl, ptax),
      note: "Premium of the on-exchange crypto dollar in Brazil vs the official PTAX. PTAX is a once-a-day fixing: part of the gap is simply intraday FX movement since the fixing.",
    },
    btc: {
      btc_brl: btcBrl, btc_usd_coinbase: btcUsd, btc_brl_implied_ptax: btcUsd && ptax ? r(btcUsd * ptax, 0) : null,
      premium_vs_ptax_pct: btcUsd && ptax ? pctOf(btcBrl, btcUsd * ptax) : null,
      premium_vs_usdt_pct: btcUsd && usdtBrl ? pctOf(btcBrl, btcUsd * usdtBrl) : null,
      note: "premium_vs_usdt isolates the BTC market itself (BRL book vs USD book, both converted at the on-exchange USDT rate); premium_vs_ptax adds the FX premium.",
    },
    sources: ["https://api.mercadobitcoin.net/api/v4/tickers", "https://api.bcb.gov.br/dados/serie/bcdata.sgs.1", "https://api.coinbase.com/v2/prices/BTC-USD/spot"],
    disclaimer: MACRO_DISCLAIMER,
  };
}

// ───────────────────────── Stablecoin supply
export async function stablecoinSupply(opts: { limit?: number } = {}) {
  const j = await memo("stables", 15 * 60_000, () => fetchJson<any>("https://stablecoins.llama.fi/stablecoins?includePrices=true", { timeoutMs: 20_000 }));
  const sumPeg = (o: any) => o && typeof o === "object" ? Object.values(o).reduce((a: number, v: any) => a + (Number(v) || 0), 0) : 0;
  const items = (j.peggedAssets as any[]).map(a => {
    const now = sumPeg(a.circulating), d = sumPeg(a.circulatingPrevDay), w = sumPeg(a.circulatingPrevWeek), m = sumPeg(a.circulatingPrevMonth);
    return { symbol: a.symbol, name: a.name, peg: a.pegType, mechanism: a.pegMechanism, price: n(a.price), circulating: Math.round(now),
      change_1d: Math.round(now - d), change_7d: Math.round(now - w), change_30d: Math.round(now - m),
      change_7d_pct: w ? r((now / w - 1) * 100, 3) : null, change_30d_pct: m ? r((now / m - 1) * 100, 3) : null,
      depeg_bps: a.pegType === "peggedUSD" && (n(a.price) ?? 0) > 0 ? Math.round(((n(a.price) as number) - 1) * 10_000) : null, chains: (a.chains ?? []).length };
  }).filter(i => i.circulating > 0).sort((a, b) => b.circulating - a.circulating);
  const usd = items.filter(i => i.peg === "peggedUSD");
  const tot = (k: "circulating" | "change_1d" | "change_7d" | "change_30d") => usd.reduce((a, i) => a + i[k], 0);
  return {
    as_of: new Date().toISOString(),
    totals_usd_pegged: { circulating: tot("circulating"), change_1d: tot("change_1d"), change_7d: tot("change_7d"), change_30d: tot("change_30d") },
    // below peg only (yield-bearing dollars like USYC/USDY trade above 1 by design); price must exist and be plausible; ≥ US$50M
    depegged_over_50bps: usd.filter(i => i.depeg_bps != null && i.depeg_bps <= -50 && (i.price ?? 0) >= 0.5 && i.circulating >= 50_000_000).map(i => ({ symbol: i.symbol, price: i.price, depeg_bps: i.depeg_bps, circulating: i.circulating })),
    items: items.slice(0, Math.min(Math.max(Number(opts.limit) || 25, 1), 200)),
    note: "Net new stablecoin supply is a proxy for fresh on-chain dollar liquidity. Mints/burns per transfer: see /v1/whales.",
    sources: ["DefiLlama stablecoins (https://stablecoins.llama.fi)"], disclaimer: MACRO_DISCLAIMER,
  };
}

// ───────────────────────── U.S. Treasury auctions
export async function treasuryAuctions(opts: { days?: number; type?: string } = {}) {
  const j = await memo("tsy", 30 * 60_000, () => fetchJson<any>("https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/auctions_query?sort=-auction_date&page%5Bsize%5D=200", { timeoutMs: 20_000 }));
  const days = Math.min(Math.max(Number(opts.days) || 14, 1), 90);
  const today = new Date().toISOString().slice(0, 10), since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const want = opts.type ? String(opts.type).toLowerCase() : null;
  const rows = (j.data as any[]).filter(x => !want || String(x.security_type).toLowerCase() === want);
  const v = (x: any) => x == null || x === "null" ? null : n(x);
  const results = rows.filter(x => x.auction_date >= since && x.auction_date <= today && (v(x.high_yield) != null || v(x.high_discnt_rate) != null || v(x.high_investment_rate) != null)).map(x => {
    const acc = v(x.total_accepted), share = (k: string) => acc && v(x[k]) != null ? r((v(x[k]) as number) / acc * 100, 1) : null;
    return { auction_date: x.auction_date, security_type: x.security_type, security_term: x.security_term, cusip: x.cusip, maturity_date: x.maturity_date,
      high_yield_pct: v(x.high_yield), high_discount_rate_pct: v(x.high_discnt_rate), high_investment_rate_pct: v(x.high_investment_rate), coupon_pct: v(x.int_rate),
      bid_to_cover: v(x.bid_to_cover_ratio), offering_usd: v(x.offering_amt), accepted_usd: acc,
      indirect_pct: share("indirect_bidder_accepted"), direct_pct: share("direct_bidder_accepted"), primary_dealer_pct: share("primary_dealer_accepted"), reopening: x.reopening === "Yes" };
  });
  const upcoming = rows.filter(x => x.auction_date >= today && v(x.high_yield) == null && v(x.high_discnt_rate) == null && v(x.high_investment_rate) == null)
    .map(x => ({ auction_date: x.auction_date, security_type: x.security_type, security_term: x.security_term, offering_usd: v(x.offering_amt), announced: x.announcemt_date, closing_time_comp: x.closing_time_comp }))
    .sort((a, b) => a.auction_date.localeCompare(b.auction_date));
  return { as_of: new Date().toISOString(), window_days: days, results, upcoming,
    note: "Primary dealers left with a large share and a low bid-to-cover are the classic signs of weak demand. When-issued yields (needed for the 'tail') are not in the public dataset.",
    sources: ["U.S. Treasury Fiscal Data — auctions_query (public domain)"], disclaimer: MACRO_DISCLAIMER };
}

// ───────────────────────── DeFi yields
export async function defiYields(opts: { min_tvl?: number; stable_only?: boolean; chain?: string; limit?: number; include_extreme?: boolean } = {}) {
  const j = await memo("yields", 30 * 60_000, () => fetchJson<any>("https://yields.llama.fi/pools", { timeoutMs: 30_000 }));
  const minTvl = Math.max(Number(opts.min_tvl) || 10_000_000, 100_000), stableOnly = opts.stable_only !== false, chain = opts.chain ? String(opts.chain).toLowerCase() : null;
  const items = (j.data as any[]).filter(p => (p.tvlUsd ?? 0) >= minTvl && (!stableOnly || p.stablecoin) && (!chain || String(p.chain).toLowerCase() === chain) && n(p.apy) != null)
    .map(p => ({ project: p.project, chain: p.chain, symbol: p.symbol, tvl_usd: Math.round(p.tvlUsd), apy_pct: r(n(p.apy), 3), apy_base_pct: r(n(p.apyBase), 3), apy_reward_pct: r(n(p.apyReward), 3),
      apy_mean_30d_pct: r(n(p.apyMean30d), 3), apy_change_7d_pp: r(n(p.apyPct7D), 3), stablecoin: !!p.stablecoin, il_risk: p.ilRisk, exposure: p.exposure, outlier: !!p.outlier,
      reward_share_pct: n(p.apy) && n(p.apyReward) ? r((n(p.apyReward) as number) / (n(p.apy) as number) * 100, 1) : 0, pool_id: p.pool }))
    .sort((a, b) => (b.apy_pct ?? 0) - (a.apy_pct ?? 0));
  // extreme = DefiLlama outlier, or APY ≥ 50 %, or APY > 3× its 30-day mean: usually a one-off spike or an incentive about to end
  const isExtreme = (i: any) => i.outlier || (i.apy_pct ?? 0) >= 50 || (i.apy_mean_30d_pct != null && i.apy_mean_30d_pct > 0 && (i.apy_pct ?? 0) > 3 * i.apy_mean_30d_pct);
  const extreme = items.filter(isExtreme);
  const shown = opts.include_extreme ? items : items.filter(i => !isExtreme(i));
  return { as_of: new Date().toISOString(), filters: { min_tvl: minTvl, stable_only: stableOnly, chain, include_extreme: !!opts.include_extreme }, count: shown.length, extreme_excluded: opts.include_extreme ? 0 : extreme.length, items: shown.slice(0, Math.min(Math.max(Number(opts.limit) || 25, 1), 200)),
    note: "APY as reported by each protocol via DefiLlama. reward_share_pct = part of the APY paid in incentive tokens (can stop or fall). outlier = flagged by DefiLlama as statistically unusual. Not a risk rating.",
    sources: ["DefiLlama yields (https://yields.llama.fi/pools)"], disclaimer: MACRO_DISCLAIMER };
}
