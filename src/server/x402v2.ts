import type { FastifyInstance } from "fastify";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/fastify";
import type { RoutesConfig, RouteConfig } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { PRICES } from "./pricing.js";
import { PACKS, CARRY, CARRY_DESK } from "./keys.js";
import { FREE_MODE } from "./access.js";

/**
 * x402 v2 payment layer (also accepts v1 payloads) via the official Fastify adapter.
 *
 * - Network: Base mainnet (CAIP-2 eip155:8453), scheme "exact" (EIP-3009 USDC).
 * - Facilitator: PayAI by default (verify/settle, gas sponsored, Base mainnet, no key).
 * - Bazaar: every priced route declares a discovery extension → auto-listed in the x402 Bazaar catalog.
 * - Free paths: our own onRequest hook decides (free mode / API key / daily quota) and marks the request
 *   with the `x-intel-access` header; the protected-request hook below then grants access without payment.
 */
const NETWORK = (process.env.X402_NETWORK === "base-sepolia" ? "eip155:84532" : "eip155:8453") as `eip155:${number}`;
const PAY_TO = process.env.X402_PAY_TO ?? "0x0000000000000000000000000000000000000000";
const FACILITATOR = process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network";
// Output examples for the Bazaar catalog (metadata completeness is a ranking factor). Real shapes, truncated values.
const CARRY_OUT: Record<string, any> = {
  carry_funding_matrix: { as_of: "2026-10-07T20:00:00.000Z", count: 330, items: [{ coin: "xyz:NBIS", dex: "xyz", base: "NBIS", funding_1h: 0.0000412, funding_apr: 0.3609, mark: 101.2, oi_usd: 8120000, vol24_usd: 22400000, spot: null }] },
  carry_xdex: { as_of: "2026-10-07T20:00:00.000Z", count: 12, items: [{ base: "NBIS", legs: [{ coin: "xyz:NBIS", dex: "xyz", funding_apr: 0.36, funding_apr_14d: 0.29 }, { coin: "io:NBIS", dex: "io", funding_apr: 0.05, funding_apr_14d: 0.08 }], spread_apr_now: 0.31, spread_apr_14d: 0.21, basis_pct: 0.42, min_leg_vol24_usd: 1900000 }] },
  carry_spot_perp: { as_of: "2026-10-07T20:00:00.000Z", count: 25, items: [{ base: "PURR", perp: "PURR", funding_apr: 0.41, funding_apr_14d: 0.37, hours_positive_14d: 0.88, basis_pct: 0.11, spot_pair: "PURR/USDC" }] },
  carry_regime: { as_of: "2026-10-26T12:00:00.000Z", days: 14, floor_apr: 0.1095, by_dex: { main: { markets: 180, at_floor_mostly: 121, premium_mostly: 38, negative_mostly: 9 } }, items: [{ coin: "xyz:NBIS", dex: "xyz", regime_now: "premium", dominant_regime: "premium", pct_hours: { floor: 12.5, premium: 80.1, negative: 4.2, zero: 3.2, between_zero_and_floor: 0 }, funding_apr_avg: 0.29 }] },
  carry_calendar: { as_of: "2026-10-26T12:00:00.000Z", days: 28, group_by: "dex", items: [{ dex: "xyz", funding_apr_by_utc_weekday: { sun: 0.02, mon: 0.31, tue: 0.33, wed: 0.29, thu: 0.3, fri: 0.27, sat: 0.01 }, weekday_apr: 0.3, weekend_apr: 0.015, weekend_to_weekday_ratio: 0.05, collapses_on_weekend: true }] },
  carry_oracle_health: { as_of: "2026-10-26T12:00:00.000Z", hours: 72, flags: [{ coin: "io:NBIS", dex: "io", flag: "frozen_funding", longest_run_h: 6, ongoing: false, weekend_hours: 0 }, { coin: "para:TSLA", peer: "xyz:TSLA", flag: "divergent_vs_peer", basis_now_pct: 1.52, basis_sd_14d_pct: 0.31, z: 4.4 }] },
  carry_extremes: { as_of: "2026-10-26T12:00:00.000Z", threshold_apr: 2, items: [{ coin: "SKHX", dex: "xyz", funding_apr_now: 4.28, realized_apr_24h: 1.9, realized_apr_7d: 0.6, realized_apr_14d: 0.2, hours_in_extreme: 5, side_paying: "longs" }] },
  carry_aftermath: { threshold_apr: 2, days: 30, episodes_count: 41, median_half_life_h: 3, episodes: [{ coin: "SAND", onset: "2026-10-20T08:00:00.000Z", funding_apr_at_onset: -10.58, side_paying: "shorts", hours_above_threshold: 4, half_life_h: 2, price_return_pct: { h4: 3.1, h12: 1.2, h24: -0.8 }, funding_accrued_pct: { h4: -0.42, h12: -0.61, h24: -0.7 } }] },
  carry_breakeven: { input: { spread_apr: 0.35, lev: 3, mode: "taker", slippage_taker_pct: 0.2, slippage_source: "assumed" }, round_trip_cost_pct_of_notional: 0.98, breakeven_days: 10.22, breakeven_apr_by_hold: { "7d": 0.511, "14d": 0.2555, "30d": 0.1192 }, net_return_on_margin_by_hold_pct: { "14d": 0.54, "30d": 2.85 } },
  carry_depth: { coin: "BTC", hours: 24, latest: { mid: 81400, spread_bps: 0.12, depth_usd: { "5bps": { bid: 4100000, ask: 3800000 }, "20bps": { bid: 21000000, ask: 19000000 } } }, median_min_side_depth_usd: { "5bps": 3600000, "20bps": 18000000 } },
  carry_history: { coin: "xyz:NBIS", dex: "xyz", hours: 168, items: [{ at: "2026-10-07T19:00:00.000Z", funding_1h: 0.0000412, funding_apr: 0.3609, premium: 0.0004, mark: 101.2, oi_usd: 8120000, vol24_usd: 22400000 }] },
  carry_naked: { as_of: "2026-10-07T20:00:00.000Z", threshold_apr: 0.5, count: 4, items: [{ coin: "kPEPE", dex: "main", funding_apr_now: 1.12, funding_apr_14d: 0.64, hours_above_threshold_14d: 210, oi_usd: 3400000, why_no_hedge: "no_spot" }] },
  carry_watchdog: { as_of: "2026-10-07T20:00:00.000Z", dexes: [{ dex: "xyz", markets: 64, active: 61, zero_oi: 2, delisted: 1, oi_usd: 412000000, vol24h_usd: 980000000, risk_flags: [] }], markets: [] },
};
const MACRO_OUT: Record<string, any> = {
  br_premium: { ptax: { usd_brl: 4.9698, date_ddmmyyyy: "06/10/2026" }, crypto_dollar: { usdt_brl: 5.0038, usdt_premium_vs_ptax_pct: 0.684 }, btc: { btc_brl: 427802, btc_usd_coinbase: 85486.6, premium_vs_ptax_pct: 0.695, premium_vs_usdt_pct: 0.01 } },
  stablecoin_supply: { totals_usd_pegged: { circulating: 314148353181, change_1d: 940735252, change_7d: 1821497520, change_30d: 4209239492 }, depegged_over_50bps: [], items: [{ symbol: "USDT", circulating: 184196143424, change_7d_pct: 0.195 }] },
  treasury_auctions: { window_days: 14, results: [{ auction_date: "2026-10-06", security_term: "3-Year", high_yield_pct: 4.932, bid_to_cover: 2.62, indirect_pct: 55.3, direct_pct: 30.4, primary_dealer_pct: 10.3 }], upcoming: [{ auction_date: "2026-10-08", security_term: "29-Year 10-Month", offering_usd: 22000000000 }] },
  defi_yields: { count: 320, extreme_excluded: 9, items: [{ project: "sky-lending", chain: "Ethereum", symbol: "SUSDS", tvl_usd: 4827061985, apy_pct: 3.6, apy_mean_30d_pct: 3.6, reward_share_pct: 0, outlier: false }] },
};
const MICRO_OUT: Record<string, any> = {
  carry_now: { coin: "BTC", dex: "main", as_of: "2026-10-07T20:00:00.000Z", funding_1h: 0.0000125, funding_apr: 0.1095, funding_apr_8h: 0.0981, funding_apr_24h: 0.1012, mark: 85480, oracle: 85460, oi_usd: 2140000000, vol24_usd: 3900000000 },
  carry_top: { as_of: "2026-10-07T20:00:00.000Z", n: 5, xdex: [{ base: "NBIS", legs: ["xyz:NBIS", "io:NBIS"], spread_apr_now: 0.31, spread_apr_14d: 0.21 }], spot_perp: [{ base: "PURR", perp: "PURR", funding_apr: 0.41, funding_apr_14d: 0.37, basis_pct: 0.11 }] },
  carry_spread: { base: "NBIS", as_of: "2026-10-07T20:00:00.000Z", legs: [{ coin: "xyz:NBIS", dex: "xyz", funding_apr: 0.36, funding_apr_14d: 0.29 }, { coin: "io:NBIS", dex: "io", funding_apr: 0.05, funding_apr_14d: 0.08 }], spread_apr_now: 0.31, spread_apr_14d: 0.21, basis_pct: 0.42 },
  hl_markets: { active: 330, delisted: 41, dexes: { main: ["BTC", "ETH", "HYPE"], xyz: ["xyz:NBIS", "xyz:TSLA"] } },
  hl_liq_near: { as_of: "2026-10-17T18:00:00.000Z", within_pct: 5, items: [{ coin: "HYPE", mark: 41.2, longs_near_liq_usd: 18400000, shorts_near_liq_usd: 2100000 }], liquidations_24h: { count: 7, notional_usd: 3200000, top_coins: [{ coin: "ETH", count: 3, notional_usd: 1900000 }] } },
  hl_liquidations: { coin: "BTC", mark: 81276, open_interest_usd: 3340000000, coverage_pct_of_oi: 16.8, longs: { positions: 41, notional_usd: 561000000, avg_entry: 80120 }, shorts: { positions: 29, notional_usd: 402000000, avg_entry: 83010 },
    nearest_long_liquidation: { price: 76100, distance_pct: -6.37, cluster_notional_usd: 24000000, cluster_positions: 3 }, nearest_short_liquidation: { price: 86900, distance_pct: 6.92, cluster_notional_usd: 15000000, cluster_positions: 2 },
    liquidation_bands: [{ side: "long", from_pct: -6, to_pct: -8, price_from: 76399, price_to: 74774, notional_usd: 38000000 }], liquidations_24h: { count: 2, notional_usd: 1400000, largest: [{ ts: "2026-10-17T14:12:00.000Z", account: "0x85ec…2052", side: "long", size: 12, px: 80410, value_usd: 964920 }] } },
  hl_smart_coin: { coin: "BTC", mark: 81400, smart_accounts: 100, smart_in_coin: 23, smart: { long_positions: 9, short_positions: 14, long_usd: 61000000, short_usd: 142000000, net_usd: -81000000, long_avg_entry: 79800, short_avg_entry: 83200 }, smart_long_share_pct: 30.05, all_tracked_long_share_pct: 22.6,
    flow: { hours: 24, net_usd: -12400000, moves: 17, largest: [{ ts: "2026-10-23T09:15:00.000Z", account: "0x85ec…2052", rank_30d_pnl: 4, pnl_30d_usd: 8400000, action: "add_short", delta_usd: -6100000, position_after_usd: 21000000, px: 81390 }] } },
  hl_smart_flow: { hours: 4, smart_accounts: 100, flows: [{ coin: "ETH", net_usd: 9300000, bought_usd: 11200000, sold_usd: 1900000, moves: 6, accounts: 4 }], positioning: [{ coin: "BTC", net_usd: -81000000, long_usd: 61000000, short_usd: 142000000, longs: 9, shorts: 14 }] },
  coin_snapshot: { symbol: "BTC", price: { mark: 81400, spot: 81380, change_24h_pct: 0.8, basis_pct: 0.02, realized_vol_30d_ann: 0.41 }, funding: { apr_now: 0.0876, apr_8h: 0.091, apr_24h: 0.083, open_interest_usd: 3290000000 },
    liquidations: { coverage_pct_of_oi: 13.2, nearest_long: { price: 80117, distance_pct: -1.75, cluster_notional_usd: 815530 }, nearest_short: { price: 82390, distance_pct: 1.03, cluster_notional_usd: 16191256 }, last_24h: { count: 2, notional_usd: 1400000 } },
    smart_money: { accounts_in_coin: 23, net_usd: -81000000, long_share_pct: 30.05, flow_24h_net_usd: -12400000 }, options: { dvol: 37.98, next_expiry: "24OCT26", atm_iv: 31.2, rr25: -2.3, max_pain: 81500, put_call_oi: 0.59 }, events_24h: { n: 4, bias: 0.12, top: [{ kind: "macro", title: "…", direction: 1 }] } },
  options_summary: { currency: "BTC", index_price: 81256.9, dvol: { now: 37.43, change_24h: -1.2 }, term_structure: [{ expiry: "24OCT26", days: 6.6, forward: 81300, atm_iv: 36.9, rr25: -2.4, bf25: 1.1, open_interest: { calls: 18200, puts: 14100 }, max_pain: 80000, max_pain_distance_pct: -1.6 }], put_call: { oi_ratio: 0.71, volume_24h_ratio: 0.88, unit: "BTC" } },
  options_maxpain: { currency: "BTC", expiry: "24OCT26", forward: 81300, max_pain: 80000, max_pain_distance_pct: -1.6, open_interest: { calls: 18200, puts: 14100 }, put_call_oi_ratio: 0.77, atm_iv: 36.9, next_expiries: ["24OCT26", "31OCT26", "27NOV26"] },
  br_ptax: { ptax_usd_brl: 4.9698, ptax_date: "06/10/2026", usdt_brl: 5.0038, usdt_premium_vs_ptax_pct: 0.684, btc_premium_vs_ptax_pct: 0.695 },
  stablecoins_total: { circulating_usd: 314148353181, change_24h_usd: 940735252, change_7d_usd: 1821497520, top3: [{ symbol: "USDT", circulating: 184196143424 }], depegs: 0 },
  treasury_next: { next: [{ auction_date: "2026-10-08", security_type: "Bond", security_term: "29-Year 10-Month", offering_usd: 22000000000 }], last_result: { auction_date: "2026-10-06", security_term: "3-Year", high_yield_pct: 4.932, bid_to_cover: 2.62 } },
};
const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://intel.degenscan.io";
const usd = (n: number) => `$${n}`;
/** Second rail: Solana mainnet (USDC, gasless via PayAI). Enabled only when a Solana receiving address is configured. */
export const SOLANA_NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;
export const PAY_TO_SOLANA = process.env.X402_PAY_TO_SOLANA || null;

/** One PaymentOption per enabled rail (Base always; Solana when configured). */
const rails = (price: string | ((ctx: any) => string)) => {
  const opts: any[] = [{ scheme: "exact", price, network: NETWORK, payTo: PAY_TO, maxTimeoutSeconds: 60 }];
  if (PAY_TO_SOLANA) opts.push({ scheme: "exact", price, network: SOLANA_NETWORK, payTo: PAY_TO_SOLANA, maxTimeoutSeconds: 60 });
  return opts;
};
const accept = (tool: string) => rails(usd(PRICES[tool]));
const common = { serviceName: "Degenscan Intel", tags: ["finance", "markets", "events", "crypto", "stocks", "macro", "regulation", "agents"], iconUrl: `${PUBLIC_URL}/icon.png` };

const EVENT_EXAMPLE = {
  id: "5e6b1f2c9a3d4e7f8a1b", ts_event: "2026-09-25T20:05:11.000Z", kind: "corp.8k", title: "CLEANSPARK, INC. files 8-K — Material definitive agreement",
  severity: 0.6, novelty: 0.7, impacts: [{ asset_id: "CLSK", direction: 0, confidence: 0.66, horizon: "days", path: ["company:CLSK"], rationale: "corp.8k on CLSK: direction unclear for CLSK" }],
  tradable_now: [], next_open: [{ asset_id: "CLSK", at: "2026-09-28T13:30:00.000Z" }], source: { id: "sec-efts", name: "SEC EDGAR 8-K (full-text search)", tier: "primary" },
};

export function buildRoutes(): RoutesConfig {
  const routes: Record<string, RouteConfig> = {
    "GET /v1/events": {
      accepts: accept("events_since"), description: "Everything that happened since <since> that touches a universe of ~150 assets (stocks, ETFs, crypto, commodities, rates), scored into per-asset impacts. Past `since` = backtest.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "4h", universe: "NVDA,BTC,CL", min_confidence: 0.2, limit: 50 },
        inputSchema: { properties: { since: { type: "string", description: "30m | 4h | 2d | ISO-8601" }, universe: { type: "string", description: "comma-separated asset ids" }, kinds: { type: "string" }, min_severity: { type: "number" }, min_confidence: { type: "number" }, q: { type: "string" }, limit: { type: "number" } } },
        output: { example: { since: "2026-09-27T10:00:00.000Z", count: 1, universe_version: "2026-09-27", events: [EVENT_EXAMPLE] } } }),
    },
    "GET /v1/impact/:asset_id": {
      accepts: accept("impact_for"), description: "Net directional pressure on one asset from recent events, with the source events.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { asset_id: "NVDA" }, pathParamsSchema: { properties: { asset_id: { type: "string", description: "Universe asset id, e.g. NVDA, BTC, CL" } }, required: ["asset_id"] }, input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } },
        output: { example: { asset: { id: "NVDA", class: "equity" }, n_events: 3, net_score: -0.42, bias: -0.7, top: [] } } }),
    },
    "GET /v1/graph/:asset_id": {
      accepts: accept("exposure_graph"), description: "Exposure sub-graph around an asset: suppliers, customers, countries, commodities, regulators, correlated assets, critical facilities.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { asset_id: "NVDA" }, pathParamsSchema: { properties: { asset_id: { type: "string", description: "Universe asset id" } }, required: ["asset_id"] }, input: { depth: 2 }, inputSchema: { properties: { depth: { type: "number" } } }, output: { example: { root: "company:NVDA", nodes: ["company:TSM", "asset:NDX"], edges: [] } } }),
    },
    "GET /v1/regime": {
      accepts: accept("regime_snapshot"), description: "Market regime snapshot: venues open now, 24h event pressure by asset, high-severity events, prediction-market context.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { venues_open: { crypto: true, US: false }, events_24h: 43, pressure: [{ asset_id: "BA", n: 10, net: 0 }] } } }),
    },
    "GET /v1/explain/:event_id": {
      accepts: accept("explain"), description: "Human-readable rationale for one event's impacts.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { event_id: "5e6b1f2c9a3d4e7f8a1b" }, pathParamsSchema: { properties: { event_id: { type: "string", description: "Event id from events_since" } }, required: ["event_id"] }, output: { example: { explanation: "…" } } }),
    },
    "GET /v1/pulse": {
      accepts: accept("pulse"), description: "Cheapest probe: last-hour event counts by class, top-3 severe events with impacts, venues open. Call hourly or as a health check before deeper calls.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { window: "1h", events: 42, by_class: { reg: 6, corp: 18, crypto: 4, media: 14 }, high_severity: 2, venues_open: { crypto: true, us_equities: false } } } }),
    },
    "GET /v1/news/:ticker": {
      accepts: accept("news_for"), description: "Headlines touching one asset (press wires, releases, halts, hacks, media) with source tier, corroboration and a heuristic sentiment score (-1..1). Links only, no bodies.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { ticker: "NVDA" }, pathParamsSchema: { properties: { ticker: { type: "string", description: "Asset id / ticker" } }, required: ["ticker"] }, input: { since: "24h", limit: 25 }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } }, output: { example: { asset: { id: "NVDA" }, count: 3, sentiment_avg: 0.25, sentiment_label: "positive", items: [{ title: "NVIDIA announces…", tier: "primary", sentiment: 0.5, url: "https://…" }] } } }),
    },
    "GET /v1/token/verdict/:address": {
      accepts: accept("token_verdict"), description: "Token contract risk verdict for agents that buy, snipe or route swaps: send a contract address (Base default; ethereum, bsc, arbitrum, polygon, optimism, avalanche via ?chain=, or a Solana mint) → DANGER / HIGH_RISK / CAUTION / LOW_RISK, 0–100 score and named flags (honeypot, taxes, mint/pause/blacklist, hidden owner, unverified, proxy, holder concentration, unlocked LP, thin/new liquidity). GoPlus + DexScreener, deterministic, 5-min cache.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { address: "0x4ed4e862860bed51a9570b96d89af5e1b0efefed" }, pathParamsSchema: { properties: { address: { type: "string", description: "Token contract address (0x… or Solana base58 mint)" } }, required: ["address"] }, input: { chain: "base" }, inputSchema: { properties: { chain: { type: "string", description: "base | ethereum | bsc | arbitrum | polygon | optimism | avalanche | solana" } } }, output: { example: { symbol: "DEGEN", chain: "base", verdict: "CAUTION", score: 72, flags: [{ id: "mintable", severity: "high", detail: "supply can be minted" }, { id: "concentrated", severity: "medium", detail: "top-10 non-contract holders own 54%" }], market: { liquidity_usd: 1250000, volume_24h_usd: 480000 } } } }),
    },
    "GET /v1/price/:symbol": {
      accepts: accept("price_for"), description: "Price probe for one coin, no key: Hyperliquid perp mark/mid/oracle + Coinbase spot, 24h change, basis, funding, plus links to our event pressure on the asset. ~1 KB, 30 s cache — made for polling.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { symbol: "BTC" }, pathParamsSchema: { properties: { symbol: { type: "string", description: "Coin, e.g. BTC, ETH, SOL" } }, required: ["symbol"] }, output: { example: { symbol: "BTC", perp: { mark: 83102, change_24h_pct: -1.76, funding_1h: 0.0000125 }, spot: { venue: "coinbase", price: 83090 }, basis_pct: 0.0144 } } }),
    },
    "GET /v1/funding/alerts": {
      accepts: accept("funding_alerts"), description: "Coins with extreme perp funding right now on Hyperliquid, sorted by |rate|, with annualized %, side paying, open interest and predicted funding per venue (Binance, Bybit, Hyperliquid). Poll every 5–15 min to catch crowded positioning.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { min_abs_rate_1h: 0.0003, limit: 15 }, inputSchema: { properties: { min_abs_rate_1h: { type: "number" }, limit: { type: "number" } } }, output: { example: { count: 2, alerts: [{ symbol: "HYPE", funding_1h: 0.0008, annualized_pct: 700.8, side_paying: "longs", open_interest_usd: 1798314282 }] } } }),
    },
    // Micro-routes for agent loops: one small object, US$0.001–0.002, 60 s cache (vendedor 07/10)
    ...Object.fromEntries(([
      ["GET /v1/carry/now/:coin", "carry_now", "Hyperliquid funding for one perp right now: annualised funding now, 8h and 24h average, mark, oracle, open interest, 24h volume. Every dex incl. HIP-3 (xyz:NBIS, io:…).", { pathParams: { coin: "BTC" }, pathParamsSchema: { properties: { coin: { type: "string", description: "BTC, ETH, HYPE… or HIP-3 dex:coin, e.g. xyz:NBIS" } }, required: ["coin"] } }],
      ["GET /v1/carry/top", "carry_top", "Top Hyperliquid funding spreads right now: top-N same-ticker spreads across HIP-3 dexes and top-N perp-vs-spot funding (numbers only).", { input: { n: 5 }, inputSchema: { properties: { n: { type: "number", description: "1–10, default 5" } } } }],
      ["GET /v1/carry/spread/:base", "carry_spread", "Funding spread for one asset listed on 2+ Hyperliquid HIP-3 dexes: each leg's annualised funding now and 14d, spread now and 14d, basis.", { pathParams: { base: "NBIS" }, pathParamsSchema: { properties: { base: { type: "string", description: "Asset ticker without dex prefix, e.g. NBIS, SNDK" } }, required: ["base"] } }],
      ["GET /v1/hl/markets", "hl_markets", "Active Hyperliquid perp markets by dex (main + HIP-3: xyz, io, para, mkts…) and the count of delisted ones.", {}],
      ["GET /v1/hl/liquidations/:coin", "hl_liquidations", "Hyperliquid liquidation map for one coin: long/short notional of the most active accounts, liquidation-price bands by distance from mark (2% steps to ±20%), nearest liquidation clusters above and below, confirmed liquidations in the last 24h. Coverage of open interest reported.", { pathParams: { coin: "BTC" }, pathParamsSchema: { properties: { coin: { type: "string", description: "Main-dex coin: BTC, ETH, SOL, HYPE…" } }, required: ["coin"] } }],
      ["GET /v1/hl/liquidations", "hl_liq_near", "Hyperliquid coins with the most tracked notional within N% of liquidation (longs and shorts) and confirmed liquidations in the last 24h.", { input: { within_pct: 5, n: 10 }, inputSchema: { properties: { within_pct: { type: "number", description: "0.5–20, default 5" }, n: { type: "number", description: "1–25, default 10" } } } }],
      ["GET /v1/coin/:symbol", "coin_snapshot", "Everything about one coin in ONE call: price and basis, Hyperliquid funding (now/8h/24h), liquidation map (nearest clusters, last 24h), smart-money positioning and 24h flow (top 30-day-PnL accounts), options for BTC/ETH (DVOL, ATM IV, 25d skew, max pain) and event pressure from primary sources.", { pathParams: { symbol: "BTC" }, pathParamsSchema: { properties: { symbol: { type: "string", description: "BTC, ETH, SOL, HYPE…" } }, required: ["symbol"] } }],
      ["GET /v1/hl/smart-money/:coin", "hl_smart_coin", "Hyperliquid smart money for one coin: how the 100 accounts with the highest 30-day PnL (public leaderboard, ≥ $5M volume) are positioned now — long/short notional, average entry — and their opens, adds, cuts and closes in the last N hours.", { pathParams: { coin: "BTC" }, pathParamsSchema: { properties: { coin: { type: "string", description: "Main-dex coin: BTC, ETH, SOL, HYPE…" } }, required: ["coin"] }, input: { hours: 24 }, inputSchema: { properties: { hours: { type: "number", description: "1–168, default 24" } } } }],
      ["GET /v1/hl/smart-money", "hl_smart_flow", "Hyperliquid smart-money flows across coins: where the top 30-day-PnL accounts added or cut exposure in the last N hours (net, bought, sold, accounts) and their biggest net positions now.", { input: { hours: 4, n: 10 }, inputSchema: { properties: { hours: { type: "number", description: "1–168, default 4" }, n: { type: "number", description: "1–25, default 10" } } } }],
      ["GET /v1/options/:currency", "options_summary", "Crypto options from Deribit (BTC, ETH): ATM implied-vol term structure, 25-delta risk reversal and butterfly, put/call open-interest and volume ratios, max pain per expiry, DVOL and its 24h change.", { pathParams: { currency: "BTC" }, pathParamsSchema: { properties: { currency: { type: "string", description: "BTC or ETH" } }, required: ["currency"] } }],
      ["GET /v1/options/maxpain/:currency", "options_maxpain", "Options max pain, open interest and put/call ratio for one Deribit expiry (default: the next expiry with open interest), BTC or ETH.", { pathParams: { currency: "BTC" }, pathParamsSchema: { properties: { currency: { type: "string", description: "BTC or ETH" } }, required: ["currency"] }, input: { expiry: "31OCT26" }, inputSchema: { properties: { expiry: { type: "string", description: "DDMMMYY, optional" } } } }],
      ["GET /v1/br/ptax", "br_ptax", "Brazil FX: today's official BCB PTAX (USD/BRL), USDT/BRL on Mercado Bitcoin now and the crypto-dollar premium over PTAX.", {}],
      ["GET /v1/stablecoins/total", "stablecoins_total", "Total stablecoin supply (USD-pegged) and its 24h / 7d net change, top-3 stablecoins, count of depegs.", {}],
      ["GET /v1/treasury/next", "treasury_next", "Next U.S. Treasury auctions (date, term, size) and the last auction result (high yield, bid-to-cover).", {}],
    ] as const).map(([route, tool, d, ext]) => [route, {
      accepts: accept(tool), description: `${d} Market data only — not investment advice.`, mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ ...(ext as any), output: { example: MICRO_OUT[tool] } }),
    } as RouteConfig])),
    ...Object.fromEntries(([
      ["GET /v1/br/premium", "br_premium", "Brazil premium: USDT/USDC-BRL on Mercado Bitcoin vs the official BCB PTAX, and BTC-BRL vs BTC-USD — how much Brazilians pay over the official dollar and over the global BTC price.", {}],
      ["GET /v1/stablecoins", "stablecoin_supply", "Stablecoin supply: circulating and 1d/7d/30d net change per stablecoin and in total (proxy for fresh on-chain dollar liquidity), plus depegs over 50 bps.", { limit: 25 }],
      ["GET /v1/treasury/auctions", "treasury_auctions", "U.S. Treasury auctions: recent results (high yield, bid-to-cover, indirect/direct/primary-dealer share) and upcoming auctions with size. Public-domain Fiscal Data.", { days: 14 }],
      ["GET /v1/defi/yields", "defi_yields", "DeFi yields: stablecoin pools above a TVL floor with APY, 30-day mean, share paid in reward tokens and outlier flag.", { min_tvl: 10000000, limit: 25 }],
    ] as const).map(([route, tool, d, input]) => [route, {
      accepts: accept(tool), description: `${d} Market data and analytics only — not investment advice.`, mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input, inputSchema: { properties: Object.fromEntries(Object.keys(input).map(k => [k, { type: "number" }])) }, output: { example: MACRO_OUT[tool] } }),
    } as RouteConfig])),
    "GET /v1/whales": {
      accepts: accept("whale_moves"), description: "Large stablecoin transfers (USDC/USDT) on Base and Ethereum from public explorers, no key: size in USD, best-effort exchange labels, flow tag (to_exchange / from_exchange / mint / burn / wallet_to_wallet), totals by flow. 60 s cache.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { min_usd: 1000000, limit: 25 }, inputSchema: { properties: { min_usd: { type: "number" }, chains: { type: "string" }, limit: { type: "number" } } }, output: { example: { count: 3, totals_usd: { to_exchange: 25000000, from_exchange: 0 }, moves: [{ chain: "ethereum", token: "USDC", usd: 25000000, from_label: "unlabeled", to_label: "Coinbase 10", flow: "to_exchange" }] } } }),
    },
    "GET /v1/polymarket/top": {
      accepts: accept("polymarket_top"), description: "Most active Polymarket markets right now: YES odds, 24h change, 24h volume, liquidity, end date, and a link to our primary-source evidence pack per market. Sort by volume, liquidity or 24h change; optional tag filter (crypto, fed, politics).", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { sort: "volume_24h", limit: 20 }, inputSchema: { properties: { sort: { type: "string" }, limit: { type: "number" }, tag: { type: "string" } } }, output: { example: { count: 20, markets: [{ question: "Fed rate cut in October?", yes_prob: 0.62, change_24h: 0.03, volume_24h_usd: 1250000 }] } } }),
    },
    "GET /v1/derivs/:symbol": {
      accepts: accept("derivs_for"), description: "Perpetual-futures microstructure for one coin from Hyperliquid's public API: funding (1h, 8h-equivalent, annualized), predicted funding by venue, open interest (coins/USD, OI-to-volume), premium vs oracle, 24h volume, 24h change, flags, plus our primary-source event pressure on the same asset.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { symbol: "BTC" }, pathParamsSchema: { properties: { symbol: { type: "string", description: "Perp coin on Hyperliquid" } }, required: ["symbol"] }, input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" } } }, output: { example: { symbol: "BTC", funding: { rate_1h: 0.0000125, annualized_pct: 10.95 }, open_interest: { usd: 1250000000 }, price: { mark: 65000, premium_vs_oracle: 0.0002 }, flags: [], event_pressure: { bias: 0.2, n_events: 4 } } } }),
    },
    "GET /v1/filings/:ticker": {
      accepts: accept("filings_for"), description: "SEC EDGAR filings touching one US issuer: 8-K by item, Form 4 insider trades, 13D/G activist stakes, S-1 offerings, with impact direction and link. Public-domain source.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { ticker: "NVDA" }, pathParamsSchema: { properties: { ticker: { type: "string", description: "Issuer ticker" } }, required: ["ticker"] }, input: { since: "7d" }, inputSchema: { properties: { since: { type: "string" }, forms: { type: "string" } } }, output: { example: { asset: { id: "COIN" }, count: 1, filings: [{ kind: "corp.8k", title: "COINBASE GLOBAL files 8-K — Results of operations", url: "https://www.sec.gov/…" }] } } }),
    },
    "GET /v1/calendar": {
      accepts: accept("calendar"), description: "Upcoming scheduled catalysts: US macro prints (CPI, jobs, PCE, GDP…) with ET times, FOMC decisions/minutes, Treasury auctions and earnings dates, each with the assets it usually moves.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { days: 7 }, inputSchema: { properties: { days: { type: "number" }, types: { type: "string" } } }, output: { example: { count: 2, items: [{ at: "2026-10-14T12:30:00.000Z", type: "macro", name: "Consumer Price Index (CPI)", affects: ["US10Y", "SPX", "BTC"] }] } } }),
    },
    "POST /v1/oracle/forecast": {
      accepts: accept("oracle_forecast"), description: "Calibrated YES-probability for a binary market question: Monte Carlo of LLM agent societies + base-rate-anchored expert panel, grounded in live price, vol, funding, Polymarket odds and calendar. Async: 202 + forecast_id, poll free. Returns probability, 80% interval, edge vs market, drivers, commitment hash. Public Brier record.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ bodyType: "json", input: { question: "Will Bitcoin close above 120,000 USD on 2026-10-31?", resolves_at: "2026-10-31T23:59:00Z", runs: 8, population: 24, rounds: 3 }, inputSchema: { properties: { question: { type: "string" }, resolves_at: { type: "string" }, context: { type: "string" }, runs: { type: "number" }, population: { type: "number" }, rounds: { type: "number" } }, required: ["question"] },
        output: { example: { forecast_id: "3f9a1c2b7d4e", status: "queued", eta_s: 150, poll: "/v1/oracle/forecast/3f9a1c2b7d4e", done_example: { probability: 0.319, ci80: [0.24, 0.41], base_rate: 0.227, market_odds: 0.35, edge: -0.031, confidence: "medium", commitment_hash: "sha256…" } } } }),
    },
    "GET /v1/oracle/edge": {
      accepts: accept("polymarket_edge"), description: "Polymarket edge list: where a calibrated forecaster disagrees most with the listed market. For every open daily-board question matched to a Polymarket market: oracle probability, 80% interval, market YES price, edge (p − odds), side, base rate, resolution date and a sha256 commitment hash; sorted by |edge|. Cached from the daily board — no LLM, made for polling. Public Brier track record.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { min_abs: 0.02, limit: 20 }, inputSchema: { properties: { min_abs: { type: "number", description: "minimum |p − odds|" }, limit: { type: "number" } } }, output: { example: { count: 2, items: [{ slug: "spx-oct-above-sep-2026", probability: 0.43, market_odds: 0.52, edge: -0.09, side: "oracle_below_market (NO looks cheap)", resolves_at: "2026-10-30T21:00:00Z", commitment_hash: "4d28eb45…" }] } } }),
    },
    "GET /v1/oracle/board": {
      accepts: accept("oracle_board"), description: "Daily board of calibrated probabilities for standing binary questions (BTC/ETH/SOL vs price targets, next FOMC, top Polymarket markets, CPI/NFP): probability, 80% interval, base rate, market odds, edge, commitment hash. Cached, refreshed daily — poll it in a loop.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: {}, inputSchema: { properties: {} }, output: { example: { count: 8, items: [{ slug: "btc-120k-oct31", question: "Will Bitcoin close above 120,000 USD on 2026-10-31?", probability: 0.319, ci_lo: 0.24, ci_hi: 0.41, base_rate: 0.227, market_odds: 0.35, edge: -0.031 }] } } }),
    },
    "GET /v1/oracle/board/:slug": {
      accepts: accept("oracle_board"), description: "One standing forecast from the daily oracle board by slug (e.g. btc-120k-oct31): probability, 80% interval, disagreement, drivers, failure modes, base rate, market odds, edge, commitment hash.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: {}, inputSchema: { properties: {} }, output: { example: { slug: "btc-120k-oct31", probability: 0.319, ci80: [0.24, 0.41], confidence: "medium" } } }),
    },
    "GET /v1/brief/:asset_id": {
      accepts: accept("brief"), description: "Premium one-call pre-trade briefing for an asset: net pressure and drivers, headlines with sentiment, SEC filings, exposure map, related Polymarket odds, upcoming catalysts, venue status. Replaces six calls.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { asset_id: "BTC" }, pathParamsSchema: { properties: { asset_id: { type: "string", description: "Universe asset id" } }, required: ["asset_id"] }, input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" } } }, output: { example: { asset: { id: "MSTR" }, pressure: { bias: -0.4, n_events: 5 }, headlines: { sentiment_avg: -0.2 }, upcoming_catalysts: [{ name: "FOMC Rate Decision" }], tradable_now: ["crypto"] } } }),
    },
    "GET /v1/polymarket/:market": {
      accepts: accept("polymarket_context"), description: "Evidence pack for one Polymarket market: current odds plus the primary-source events (Fed, SEC, agencies, disasters, hacks) in our feed that bear on the question, with relevance and corroboration. For agents trading or quoting prediction markets.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ pathParams: { market: "fed-rate-cut" }, pathParamsSchema: { properties: { market: { type: "string", description: "Polymarket market id, slug or question text" } }, required: ["market"] }, input: { since: "48h", limit: 15 }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } }, output: { example: { market: { question: "Fed rate cut in October?", yes_prob: 0.62, change_24h: 0.03 }, n_related: 2, related: [{ kind: "cb.speech", title: "Fed Governor: inflation progress supports easing", tier: "primary", relevance: 0.5 }] } } }),
    },
    // Prepaid API keys for autonomous agents: one USDC payment → key with a lifetime call budget. One route per pack so the
    // price is static (the payment middleware runs before the body is parsed, so it must never depend on the body).
    ...Object.fromEntries(Object.entries(PACKS).map(([pack, p]) => [`POST /v1/keys/x402/${pack}`, {
      accepts: rails(usd(p.usd)),
      description: `Buy a prepaid API key (${p.calls.toLocaleString()} calls, lifetime, $${p.usd}) with USDC — no account, no card, no human. Then send X-API-KEY on /v1/* or POST /mcp. Other packs: ${Object.entries(PACKS).filter(([k]) => k !== pack).map(([k, v]) => `${k} $${v.usd}`).join(", ")}.`,
      mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ bodyType: "json", input: {}, inputSchema: { properties: {} },
        output: { example: { api_key: `dsi_${pack}_…`, key_id: "k_…", pack, calls: p.calls, paid_usd: p.usd, usage: "send header X-API-KEY on /v1/* or POST /mcp", check: `${PUBLIC_URL}/v1/keys/me` } } }),
    } as RouteConfig])),
    // Carry Oracle Data routes: pay per call in USDC, or send X-API-KEY with a Carry subscription key (flat US$100/month, unlimited).
    ...Object.fromEntries(([
      ["GET /v1/carry/funding-matrix", "carry_funding_matrix", "Annualised funding for every perp on every Hyperliquid dex (main + HIP-3), with OI, 24h volume and spot mark."],
      ["GET /v1/carry/xdex", "carry_xdex", "Same ticker on 2+ HIP-3 dexes: funding spread now and 14d, % positive hours, basis, thinner-leg liquidity."],
      ["GET /v1/carry/spot-perp", "carry_spot_perp", "Main-dex perp vs spot: funding now and 14d, % positive hours, perp/spot basis."],
      ["GET /v1/carry/history/:coin", "carry_history", "Hourly funding/premium/mark/OI/volume for one coin, kept beyond Hyperliquid's 500 h window (HIP-3 coins prefixed, e.g. xyz:NBIS)."],
      ["GET /v1/carry/naked", "carry_naked", "Funding extremes with no hedge leg on Hyperliquid (no spot, no same-ticker HIP-3 listing). Raw data."],
      ["GET /v1/carry/regime", "carry_regime", "Share of hours each Hyperliquid market spent at the 10.95 %/yr funding floor, in premium, negative or zero (14 d), current regime, by dex."],
      ["GET /v1/carry/calendar", "carry_calendar", "Hyperliquid funding by UTC weekday per dex (or one coin): weekday vs weekend average, which HIP-3 dexes collapse on weekends."],
      ["GET /v1/carry/oracle-health", "carry_oracle_health", "Oracle quality flags for every Hyperliquid perp: frozen funding (0.0 for ≥ 4 h), stale oracle price, HIP-3 legs diverging from same-underlying peers (z-score)."],
      ["GET /v1/carry/extremes", "carry_extremes", "Hyperliquid funding extremes (default |APR| ≥ 200 %) with realized 24h/7d/14d averages next to the instant rate and hours spent in the extreme."],
      ["GET /v1/carry/extremes/aftermath", "carry_aftermath", "Past Hyperliquid funding-extreme episodes: price return and funding accrued 4/12/24 h after onset, hours above threshold, half-life."],
      ["GET /v1/carry/breakeven", "carry_breakeven", "Round-trip cost, break-even days and net return on margin for a funding spread by execution mode (taker / one maker leg / all maker); slippage assumed and overridable."],
      ["GET /v1/carry/depth/:coin", "carry_depth", "Hourly order-book depth (USD at 5/10/20/50 bps each side) and spread for the 40 most traded Hyperliquid perps — Hyperliquid keeps no book history."],
      ["GET /v1/carry/watchdog", "carry_watchdog", "Health of every Hyperliquid perp market and dex: status, OI/volume and 7-day change, growth mode, risk flags."],
    ] as const).map(([route, tool, d]) => [route, {
      accepts: accept(tool), description: `Carry Oracle — ${d} Or subscribe: US$${CARRY.usd_month}/month flat, unlimited (card ${PUBLIC_URL}/v1/carry/checkout or POST /v1/keys/x402/carry_month). Docs ${PUBLIC_URL}/docs/carry. Market data and analytics only — not a signal, not investment advice.`,
      mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension(route.includes(":coin") ? { pathParams: { coin: "xyz:NBIS" }, pathParamsSchema: { properties: { coin: { type: "string", description: "Hyperliquid coin; HIP-3 coins prefixed by dex, e.g. xyz:NBIS" } }, required: ["coin"] }, input: { hours: 168 }, inputSchema: { properties: { hours: { type: "number" } } }, output: { example: CARRY_OUT[tool] } } : { input: {}, inputSchema: { properties: { min_vol: { type: "number" }, limit: { type: "number" } } }, output: { example: CARRY_OUT[tool] } }),
    } as RouteConfig])),
    "POST /v1/keys/x402/carry_desk_month": {
      accepts: rails(usd(CARRY_DESK.usd_month)),
      description: `Carry Desk — 30 days for ${CARRY_DESK.usd_month} USDC: everything in Carry Data plus eligibility filters, per-pair capacity, net realized carry, after-hours premium and webhook alerts. Limited seats; when closed or full the request is refused before any payment settles. Data and analytics only — not investment advice.`,
      mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ bodyType: "json", input: {}, inputSchema: { properties: {} }, output: { example: { api_key: "dsi_carrydesk_…", key_id: "k_…", product: "carry_desk_month" } } }),
    } as RouteConfig,
    "POST /v1/keys/x402/carry_month": {
      accepts: rails(usd(CARRY.usd_month)),
      description: `Carry Oracle — 30 days of unlimited access to /v1/carry/* (Hyperliquid funding on every dex, cross-dex spreads, hourly history kept without a window) for a flat ${CARRY.usd_month} USDC. Returns an X-API-KEY. Data and analytics only — not investment advice.`,
      mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ bodyType: "json", input: {}, inputSchema: { properties: {} }, output: { example: { api_key: "dsi_carry_…", key_id: "k_…", product: "carry_month", expires_at: "2026-11-03T00:00:00Z" } } }),
    } as RouteConfig,
    "POST /mcp": {
      // MCP: price depends on the tool being called; handshake/tools/list are granted for free by the access hook.
      accepts: rails((ctx: any) => { const b: any = ctx.adapter.getBody?.(); const t = String(b?.params?.name ?? ""); return usd(PRICES[t] ?? 0.005); }),
      description: "MCP server (streamable HTTP). Tools: events_since, impact_for, exposure_graph, regime_snapshot, explain, universe, sources_status.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ bodyType: "json",
        input: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "events_since", arguments: { since: "4h", universe: ["NVDA", "BTC"] } } },
        inputSchema: { properties: { jsonrpc: { type: "string" }, id: { type: "number" }, method: { type: "string", description: "tools/call (initialize and tools/list are free)" }, params: { type: "object", properties: { name: { type: "string", description: "events_since | impact_for | exposure_graph | regime_snapshot | explain | universe | sources_status" }, arguments: { type: "object" } } } }, required: ["jsonrpc", "method"] },
        output: { example: { jsonrpc: "2.0", id: 1, result: { structuredContent: { count: 1, events: [EVENT_EXAMPLE] } } } } }),
    },
  };
  return routes;
}

export async function installX402(app: FastifyInstance) {
  // Facilitators: Coinbase CDP first when credentials exist (its settlements are what the Coinbase Bazaar indexes), PayAI always
  // (Base + Solana, gasless, no key). The resource server picks the first facilitator that supports the requested scheme/network.
  const payai = new HTTPFacilitatorClient({ url: FACILITATOR, timeoutMs: 30_000 });
  const cdpId = process.env.CDP_API_KEY_ID, cdpSecret = process.env.CDP_API_KEY_SECRET;
  const clients = cdpId && cdpSecret ? [new HTTPFacilitatorClient({ ...createFacilitatorConfig(cdpId, cdpSecret), timeoutMs: 30_000 } as any), payai] : [payai];
  const rs = new x402ResourceServer(clients).register(NETWORK, new ExactEvmScheme()).registerExtension(bazaarResourceServerExtension);
  if (PAY_TO_SOLANA) registerExactSvmScheme(rs, { networks: [SOLANA_NETWORK] });
  const http = new x402HTTPResourceServer(rs, buildRoutes());
  http.onProtectedRequest(async (ctx) => {
    // Set by our onRequest hook (see http.ts). Anything other than "pay" means the request is already authorized.
    const access = ctx.adapter.getHeader("x-intel-access");
    if (access && access !== "pay") return { grantAccess: true };
    return;
  });
  // syncFacilitatorOnStart=false: we initialize explicitly so a facilitator hiccup at boot doesn't crash the process.
  paymentMiddlewareFromHTTPServer(app, http, undefined, undefined, false);
  if (!FREE_MODE) {
    try { await http.initialize(); console.log(`[x402] v2 ready — ${NETWORK} → ${PAY_TO}${PAY_TO_SOLANA ? ` + ${SOLANA_NETWORK} → ${PAY_TO_SOLANA}` : ""} via ${cdpId && cdpSecret ? "Coinbase CDP + " : ""}${FACILITATOR}`); }
    catch (e) { console.warn("[x402] facilitator sync failed at boot (will retry on first payment):", (e as Error).message); }
  }
  return http;
}
