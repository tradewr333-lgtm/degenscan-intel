import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TokenVerdictArgs, tokenVerdict } from "./token-verdict.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, PolymarketContextArgs, NewsArgs, FilingsArgs, CalendarArgs, BriefArgs, DerivsArgs, PriceArgs, FundingAlertsArgs, WhaleArgs, PolyTopArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, polymarketContext, pulse, newsFor, filingsFor, calendar, brief, derivsFor, priceFor, fundingAlerts, whaleMoves, polymarketTop } from "./tools.js";
import { PRICES } from "./pricing.js";
import { ForecastRequest, DISCLAIMER } from "../oracle/schema.js";
import { enqueueForecast, _queue } from "../oracle/queue.js";
import { boardLatest, getForecast, getJob, recentForecasts, trackRecord } from "../oracle/ledger.js";
import { llmConfigured } from "../oracle/llm.js";
import { carryAccess, CARRY, createTrialKey, TRIAL, validateKey } from "./keys.js";
import { createHash } from "node:crypto";
import { fundingMatrix, crossDex, spotPerp, coinHistory, naked, watchdog } from "../carry/hl.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }], structuredContent: x as Record<string, unknown> });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true });

/** Build the MCP server. One instance per stateless HTTP request is fine (cheap). */
export function buildMcpServer(ctx: { carryKey?: string; operator?: boolean; carryPaid?: boolean; ip?: string } = {}) {
  const s = new McpServer({ name: "degenscan-intel", version: "0.10.48" }, {
    instructions: [
      "Degenscan Intel: cross-asset event feed for trading agents. Events are normalized from ~40 primary sources (SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket…) and scored against an exposure graph into per-asset impacts.",
      "Cheapest probe: pulse ($0.001). One-call briefing per asset: brief ($0.10). Typical loop: regime_snapshot → events_since(since='4h', universe=[your book]) → impact_for(asset_id) for anything with confidence ≥ 0.4 → check tradable_now / next_open before acting. For prediction markets: polymarket_context(market) → compare yes_prob with fresh primary-source events.",
      `Pricing per call (USDC via x402, or API key): ${Object.entries(PRICES).map(([k, v]) => `${k}=$${v}`).join(", ")}. universe and sources_status are free.`,
      "Direction: 1 supportive, -1 negative, 0 unclear. Confidence is a 0..1 product of source tier, event severity/novelty and graph path weight — not a probability.",
      "Access: initialize/tools/list/universe/sources_status are free. Priced tools: 100 free calls/day per IP over MCP (REST needs header X-Free-Trial: 1), then pay per call with x402 (USDC on Base) or send X-API-KEY. Autonomous agents can buy a prepaid key with USDC (no human): POST /v1/keys/x402/pack_1k ($5 = 1,000 calls). Details: /llms.txt.",
      "Oracle (conclusion, not data): oracle_forecast(question) returns a forecast_id (async, 1–3 min, $0.25); poll oracle_get(forecast_id) (free) until status=done for a calibrated YES-probability with 80% interval, base rate, market odds, edge, drivers, failure modes and a sha256 commitment hash. oracle_board ($0.002) is the daily set of standing forecasts, no waiting. oracle_track_record (free) is the public Brier record.",
      "Information and analytics only — not investment advice.",
    ].join("\n"),
  });
  // Disambiguation (Glama TDQS): every tool says when to use it and which sibling to use instead.
  const WHEN: Record<string, string> = {
    pulse: "Use first as a cheap heartbeat; for the events themselves use events_since, for one asset use brief.",
    events_since: "Use to pull the event list for a window/universe; for one asset's scored impacts use impact_for, for a one-call asset summary use brief.",
    impact_for: "Use for one asset's scored impacts; for raw events use events_since, for a full asset briefing use brief.",
    exposure_graph: "Use to see which assets are linked to one asset; not for prices or events.",
    regime_snapshot: "Use for the market-wide state (venues open, pressure by asset); for one asset use brief.",
    explain: "Use only with an event_id returned by events_since or impact_for.",
    brief: "Use when you want everything about ONE asset in one call (replaces ~6 calls); for many assets use events_since + impact_for.",
    price_for: "Use for one coin's price/basis/funding now; for funding history use carry_history, for all perps at once use carry_funding_matrix.",
    derivs_for: "Use for one perp's funding/OI with event pressure; for price only use price_for, for every perp use carry_funding_matrix.",
    funding_alerts: "Use to find which perps have extreme funding now (cross-venue); for every Hyperliquid dex incl. HIP-3 use carry_funding_matrix.",
    whale_moves: "Use for individual large stablecoin transfers; for total supply change use stablecoin_supply.",
    stablecoin_supply: "Use for total stablecoin supply and net change; for individual large transfers use whale_moves.",
    hl_liquidations: "Use for where Hyperliquid positions get liquidated for one coin; for funding use carry_now.",
    coin_snapshot: "Use first when you need the full picture of one coin in one call; then drill down with the specific tools.",
    hl_smart_coin: "Use for how top-PnL Hyperliquid traders are positioned in one coin; for all coins use hl_smart_flow.",
    hl_smart_flow: "Use to see where top-PnL Hyperliquid traders are adding or cutting exposure across coins.",
    hl_liq_near: "Use to scan which Hyperliquid coins have the most positions close to liquidation.",
    options_summary: "Use for BTC/ETH options implied vol, skew, put/call and max pain; for perp funding use derivs_for.",
    options_maxpain: "Use for one expiry's max pain and open interest only.",
    hl_candles: "Use for price history (OHLCV) of one Hyperliquid perp; for price now use price_for.",
    polymarket_leaderboard: "Use to see which Polymarket traders made the most PnL or volume; for markets use polymarket_top.",
    base_balance: "Use to read a Base wallet's ETH, USDC or any ERC-20 balance now.",
    gas_base: "Use before sending a Base transaction to pick fees and estimate cost in USD.",
    hl_basis: "Use for one Hyperliquid perp's premium vs oracle and predicted funding vs Binance/Bybit; for the full coin picture use coin_snapshot.",
    br_premium: "Use for Brazil's crypto-dollar/BTC premium vs the official PTAX; not for other FX.",
    treasury_auctions: "Use for U.S. Treasury auction results and the upcoming calendar; for all macro releases use calendar.",
    defi_yields: "Use for stablecoin pool APYs; not a risk rating.",
    calendar: "Use for upcoming scheduled macro/earnings catalysts; for Treasury auction details use treasury_auctions.",
    news_for: "Use for headlines about one ticker; for SEC filings use filings_for.",
    filings_for: "Use for SEC filings of one issuer; for headlines use news_for.",
    polymarket_top: "Use to find the most active prediction markets; for one market's evidence use polymarket_context, for oracle disagreement use polymarket_edge.",
    polymarket_context: "Use for one market's odds plus related primary-source events; to discover markets use polymarket_top.",
    polymarket_edge: "Use to list markets where the oracle and market odds disagree most; for one new question use oracle_forecast.",
    oracle_forecast: "Use to ask a NEW binary question (async, returns forecast_id); then poll oracle_get. For today's standing forecasts use oracle_board.",
    oracle_get: "Use only to poll a forecast_id returned by oracle_forecast (free).",
    oracle_board: "Use for today's standing forecasts without waiting; to ask your own question use oracle_forecast.",
    oracle_track_record: "Use to audit the oracle's public accuracy (free).",
    universe: "Use to list valid asset ids for other tools (free).",
    sources_status: "Use to check the health of each primary source (free).",
    keys_trial: "Use once to get a free trial key (200 calls, 7 days); then send it as X-API-KEY.",
    token_verdict: "Use for one token contract's risk checks; not a price or a recommendation.",
    carry_funding_matrix: "Use for ALL perps on ALL Hyperliquid dexes at once; for one coin use price_for or carry_history.",
    carry_xdex: "Use for the same ticker priced on 2+ HIP-3 dexes; for perp vs spot use carry_spot_perp.",
    carry_spot_perp: "Use for main-dex perp vs its spot market; for cross-dex HIP-3 pairs use carry_xdex.",
    carry_history: "Use for one coin's hourly history beyond 500 h; for the current snapshot of all coins use carry_funding_matrix.",
    carry_naked: "Use for funding extremes that cannot be hedged on Hyperliquid; for hedgeable pairs use carry_xdex or carry_spot_perp.",
    carry_regime: "Use for how often a market sits at the funding floor vs premium; for current levels use carry_funding_matrix.",
    carry_calendar: "Use for weekday/weekend funding patterns per dex or coin.",
    carry_oracle_health: "Use to check frozen funding, stale oracles or diverging HIP-3 legs before trusting a market.",
    carry_extremes: "Use for funding extremes with realized averages; for history after extremes use carry_aftermath.",
    carry_aftermath: "Use for what happened after past funding extremes (price, funding accrued, half-life).",
    carry_breakeven: "Use to compute fees/slippage break-even for a funding spread.",
    carry_depth: "Use for order-book depth history of a Hyperliquid perp.",
    carry_watchdog: "Use for market and dex health (delistings, OI drops); not for funding levels.",
  };
  const _reg = s.registerTool.bind(s) as any;
  (s as any).registerTool = (name: string, cfg: any, cb: any) => _reg(name, WHEN[name] && cfg?.description ? { ...cfg, description: `${cfg.description} ${WHEN[name]}` } : cfg, cb);


  s.registerTool("events_since", {
    title: "Events since", description: `List market-moving events since a point in time (natural disasters, regulator actions, central-bank releases, federal rules, SEC filings, trading halts, on-chain hacks, prediction-market shifts), each scored into per-asset impacts (direction −1/0/+1, confidence 0..1, horizon) with tradable_now / next_open per asset. Use it to answer "what happened in the last N hours that affects my book" or, with a past \`since\`, to backtest. Filter with universe=["NVDA","BTC"] and min_confidence≥0.4 to act on. $${PRICES.events_since}/call; 100 free calls/day.`,
    inputSchema: EventsSinceArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(eventsSince(EventsSinceArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("impact_for", {
    title: "Impact for asset", description: `Net directional pressure on ONE asset over a window: bias (−1..+1), number of events, strongest supportive and negative drivers, and the source events with rationale and graph path. Use it before entering or sizing a position in that asset, or to explain a move ("why is MSTR down today?"). $${PRICES.impact_for}/call.`,
    inputSchema: ImpactForArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(impactFor(ImpactForArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("exposure_graph", {
    title: "Exposure graph", description: `Who and what an asset is exposed to: suppliers, customers, countries of revenue/production, input commodities, regulators, indices that hold it, correlated assets and critical facilities (fabs, ports, straits) with coordinates. Use it to find second-order trades (an event on TSM → NVDA, AAPL) or to know which regulators/countries to watch for a holding. $${PRICES.exposure_graph}/call.`,
    inputSchema: ExposureGraphArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(exposureGraph(ExposureGraphArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("regime_snapshot", {
    title: "Regime snapshot", description: `One-call situational picture for right now: which venues are open (US equities, futures, FX, crypto) and the next opens, 24h event pressure ranked by asset, the highest-severity events, and prediction-market probabilities (Fed, shutdown, tariffs…). Call it first in a session, or every few hours, to decide whether to look deeper. $${PRICES.regime_snapshot}/call.`,
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => { try { return json(regimeSnapshot()); } catch (e) { return fail(e); } });

  s.registerTool("explain", {
    title: "Explain event", description: `Plain-language explanation of ONE event's impacts: why each asset got its direction and confidence, the exposure-graph path used, the source document link and corroborating sources. Use it when an impact from events_since/impact_for is surprising and you need the reasoning before acting, or to log a rationale. Takes the event id from those tools. $${PRICES.explain}/call.`,
    inputSchema: { event_id: z.string() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(explain(a.event_id)); } catch (e) { return fail(e); } });

  s.registerTool("polymarket_context", {
    title: "Polymarket context", description: `Evidence pack for ONE prediction market: resolves a Polymarket market (id, slug or question text) to its current odds, then returns the primary-source events in our feed (regulators, Fed, filings, disasters, hacks…) that bear on the question, with relevance, source tier, corroboration and per-asset impacts. Use it before trading or quoting a probability on Polymarket/Kalshi-style markets ("Fed cut in October?", "ETF approved by year end?"), or to detect a fresh primary event the market hasn't repriced. Information, not a forecast. $${PRICES.polymarket_context}/call.`,
    inputSchema: PolymarketContextArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await polymarketContext(PolymarketContextArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("pulse", {
    title: "Pulse (1h)", description: `Cheapest first call: how many events hit the feed in the last hour by class (natural, regulatory, central-bank, corporate, crypto, media…), the 3 most severe with their top impacts, and which venues are open. Use it every hour to decide whether anything needs a deeper look, or as a health/probe call. $${PRICES.pulse}/call.`,
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => { try { return json(pulse()); } catch (e) { return fail(e); } });

  s.registerTool("price_for", {
    title: "Price probe", description: `Cheapest price check for ONE coin, no key: Hyperliquid perp mark/mid/oracle, Coinbase spot, 24h change, perp-spot basis, current funding, plus links to our event pressure on that asset. ~1 KB, cached 30 s — made for polling loops. $${PRICES.price_for}/call.`,
    inputSchema: PriceArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await priceFor(PriceArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("token_verdict", {
    title: "Token risk verdict", description: `Before buying, sniping or routing a swap: send a token contract address (EVM: base default, ethereum, bsc, arbitrum, polygon, optimism, avalanche; or a Solana mint) and get a deterministic risk verdict — DANGER / HIGH_RISK / CAUTION / LOW_RISK with a 0–100 score and named flags: honeypot, sell/buy tax, mintable, pausable, blacklist, hidden or reclaimable owner, unverified source, proxy, holder concentration, creator share, unlocked LP, thin or brand-new liquidity. Sources: GoPlus + DexScreener, 5-min cache. $${PRICES.token_verdict}/call.`,
    inputSchema: TokenVerdictArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await tokenVerdict(TokenVerdictArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("funding_alerts", {
    title: "Funding alerts", description: `Which perps have extreme funding RIGHT NOW on Hyperliquid: sorted by |hourly rate| with annualized %, which side is paying (crowded longs vs shorts), open interest and predicted next funding per venue (Hyperliquid, Binance, Bybit). Use every 5–15 min to detect crowded positioning or to pick a side to receive funding. $${PRICES.funding_alerts}/call.`,
    inputSchema: FundingAlertsArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await fundingAlerts(FundingAlertsArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("whale_moves", {
    title: "Whale moves", description: `Large USDC/USDT transfers on Base and Ethereum from public explorers (no key): USD size, best-effort exchange labels (Binance, Coinbase, OKX, Bybit…), flow tag (to_exchange = potential sell pressure, from_exchange = withdrawal, mint/burn = stablecoin supply, wallet_to_wallet), totals by flow, tx links. Default threshold $1M. $${PRICES.whale_moves}/call.`,
    inputSchema: WhaleArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await whaleMoves(WhaleArgs.parse(a))); } catch (e) { return fail(e); } });

  {
    const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
    s.registerTool("hl_liquidations", { title: "Hyperliquid liquidation map", description: `Liquidation map for one Hyperliquid main-dex coin from the most active accounts (public leaderboard, refreshed every 15 min): longs/shorts {positions, notional_usd, avg_entry}, liquidation_bands[] (side, from_pct/to_pct from mark, price range, notional_usd), nearest_long/short_liquidation {price, distance_pct, cluster_notional_usd}, liquidations_24h (confirmed by Hyperliquid's liquidation marker), coverage_pct_of_oi. A sample, not the whole book. $${PRICES.hl_liquidations}/call.`, inputSchema: { coin: z.string().describe("Main-dex coin, e.g. BTC, ETH, HYPE") }, annotations: ro },
      async (a: any) => { try { const v = await (await import("../carry/liq.js")).liqMap(a.coin); return v ? json(v) : fail(new Error("unknown coin")); } catch (e) { return fail(e); } });
    s.registerTool("hl_liq_near", { title: "Hyperliquid positions near liquidation", description: `Hyperliquid coins ranked by tracked notional within within_pct% of liquidation (longs_near_liq_usd, shorts_near_liq_usd) plus confirmed liquidations 24h. $${PRICES.hl_liq_near}/call.`, inputSchema: { within_pct: z.number().min(0.5).max(20).optional().describe("Distance from liquidation, %, default 5"), n: z.number().int().min(1).max(25).optional() }, annotations: ro },
      async (a: any) => { try { return json(await (await import("../carry/liq.js")).liqNear(a.within_pct, a.n)); } catch (e) { return fail(e); } });
    s.registerTool("coin_snapshot", { title: "Coin snapshot (one call)", description: `Everything about one coin in one call: price {mark, spot, change_24h_pct, basis_pct, realized_vol_30d_ann}, funding {apr_now, apr_8h, apr_24h, open_interest_usd}, liquidations {coverage_pct_of_oi, nearest_long, nearest_short, last_24h}, smart_money {net_usd, long_share_pct, flow_24h_net_usd}, options for BTC/ETH {dvol, atm_iv, rr25, max_pain, put_call_oi}, events_24h {n, bias, top[]}. Blocks are null when unavailable. $${PRICES.coin_snapshot}/call.`, inputSchema: { symbol: z.string().describe("BTC, ETH, SOL, HYPE…") }, annotations: ro },
      async (a: any) => { try { const v = await (await import("./coin.js")).coinSnapshot(a.symbol); return v ? json(v) : fail(new Error("unknown symbol")); } catch (e) { return fail(e); } });
    s.registerTool("hl_smart_coin", { title: "Hyperliquid smart money (one coin)", description: `How the 100 Hyperliquid accounts with the highest 30-day PnL (public leaderboard, ≥ $5M volume, positive ROI) are positioned in one coin: smart {long_positions, short_positions, long_usd, short_usd, net_usd, avg entries}, smart_long_share_pct vs all_tracked_long_share_pct, flow {hours, net_usd, moves, largest[] (account, rank_30d_pnl, action open/add/reduce/close/flip, delta_usd)}. $${PRICES.hl_smart_coin}/call.`, inputSchema: { coin: z.string().describe("Main-dex coin, e.g. BTC"), hours: z.number().min(1).max(168).optional().describe("Lookback for moves, default 24") }, annotations: ro },
      async (a: any) => { try { return json(await (await import("../carry/liq.js")).smartCoin(a.coin, a.hours)); } catch (e) { return fail(e); } });
    s.registerTool("hl_smart_flow", { title: "Hyperliquid smart-money flows", description: `Across coins: flows[] {coin, net_usd, bought_usd, sold_usd, moves, accounts} of the top 30-day-PnL Hyperliquid accounts in the last N hours, and positioning[] {coin, net_usd, long_usd, short_usd}. $${PRICES.hl_smart_flow}/call.`, inputSchema: { hours: z.number().min(1).max(168).optional().describe("Default 4"), n: z.number().int().min(1).max(25).optional() }, annotations: ro },
      async (a: any) => { try { return json((await import("../carry/liq.js")).smartFlow(a.hours, a.n)); } catch (e) { return fail(e); } });
    s.registerTool("options_summary", { title: "Crypto options (Deribit)", description: `BTC or ETH options from Deribit public data: term_structure[] {expiry, days, forward, atm_iv %, rr25 (25d call IV − 25d put IV, vol pts), bf25, open_interest {calls, puts}, max_pain, max_pain_distance_pct}, put_call {oi_ratio, volume_24h_ratio}, dvol {now, change_24h}, top_open_interest[]. $${PRICES.options_summary}/call.`, inputSchema: { currency: z.enum(["BTC", "ETH"]) }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./options.js")).optionsSummary(a.currency)); } catch (e) { return fail(e); } });
    s.registerTool("options_maxpain", { title: "Options max pain", description: `Max pain, open interest and put/call ratio for one Deribit expiry (default the next with open interest), BTC or ETH. $${PRICES.options_maxpain}/call.`, inputSchema: { currency: z.enum(["BTC", "ETH"]), expiry: z.string().optional().describe("DDMMMYY, e.g. 31OCT26") }, annotations: ro },
      async (a: any) => { try { const v = await (await import("./options.js")).optionsMaxPain(a.currency, a.expiry); return v ? json(v) : fail(new Error("unknown expiry")); } catch (e) { return fail(e); } });
    s.registerTool("hl_candles", { title: "Hyperliquid candles", description: `OHLCV candles for one Hyperliquid perp (main or HIP-3): candles[] {t,o,h,l,c,v,trades}, summary {open, close, change_pct, high, low, range_pct, vwap}. $${PRICES.hl_candles}/call.`, inputSchema: { coin: z.string().describe("e.g. BTC or xyz:NBIS"), interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]).optional(), limit: z.number().int().min(1).max(500).optional() }, annotations: ro },
      async (a: any) => { try { const v = await (await import("./scoutrep.js")).hlCandles(a.coin, a.interval, a.limit); return v ? json(v) : fail(new Error("no candles")); } catch (e) { return fail(e); } });
    s.registerTool("polymarket_leaderboard", { title: "Polymarket leaderboard", description: `Polymarket top traders: items[] {rank, wallet, name, pnl_usd, volume_usd, pnl_to_volume_pct} for day/week/month/all, by pnl or volume. $${PRICES.polymarket_leaderboard}/call.`, inputSchema: { period: z.enum(["day", "week", "month", "all"]).optional(), by: z.enum(["pnl", "volume"]).optional(), limit: z.number().int().min(1).max(50).optional() }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./scoutrep.js")).polymarketLeaderboard(a.period, a.by, a.limit)); } catch (e) { return fail(e); } });
    s.registerTool("base_balance", { title: "Base wallet balance", description: `Base (8453) balance of one address: eth, usdc and optional token {address, symbol, decimals, balance}, block. $${PRICES.base_balance}/call.`, inputSchema: { address: z.string().describe("0x wallet"), token: z.string().optional().describe("optional ERC-20 contract 0x…") }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./scoutrep.js")).baseBalance(a.address, a.token)); } catch (e) { return fail(e); } });
    s.registerTool("gas_base", { title: "Base gas now", description: `Base (8453) gas: base_fee_gwei, next_base_fee_gwei, priority_fee_gwei {p10,p50,p90}, suggested {low,medium,high} EIP-1559 fees, l2_execution_cost {eth_transfer, erc20_transfer, dex_swap} in ETH and USD. $${PRICES.gas_base}/call.`, inputSchema: {}, annotations: ro },
      async () => { try { return json(await (await import("./scoutrep.js")).gasBase()); } catch (e) { return fail(e); } });
    s.registerTool("hl_basis", { title: "Hyperliquid perp basis", description: `One Hyperliquid main-dex perp: mark_oracle_premium_bps, impact_premium_bps, impact_spread_bps, funding {hourly, per_8h, apr_pct, apr_24h_mean_pct, apr_7d_mean_pct, positive_share_7d_pct}, predicted_funding[] {venue hyperliquid|binance|bybit, apr_pct, next_funding}, open_interest_usd. $${PRICES.hl_basis}/call.`, inputSchema: { coin: z.string().describe("e.g. BTC, ETH, HYPE") }, annotations: ro },
      async (a: any) => { try { const v = await (await import("./scoutrep.js")).hlBasis(a.coin); return v ? json(v) : fail(new Error("unknown coin")); } catch (e) { return fail(e); } });
    s.registerTool("br_premium", { title: "Brazil crypto premium", description: `Crypto-dollar and BTC premium in Brazil: USDT/USDC-BRL on Mercado Bitcoin vs the official BCB PTAX, BTC-BRL vs BTC-USD (Coinbase) at PTAX and at the on-exchange USDT rate. $${PRICES.br_premium}/call.`, inputSchema: {}, annotations: ro },
      async () => { try { return json(await (await import("./macro.js")).brPremium()); } catch (e) { return fail(e); } });
    s.registerTool("stablecoin_supply", { title: "Stablecoin supply", description: `Stablecoin supply from DefiLlama. Returns totals_usd_pegged {circulating, change_1d, change_7d, change_30d} in USD, depegged_over_50bps[] (USD stablecoins trading below $0.995 with ≥ $50M supply: symbol, price, depeg_bps, circulating), and items[] per stablecoin (symbol, peg, mechanism, price, circulating, change_1d/7d/30d, change_7d_pct, change_30d_pct, chains), sorted by supply. Net new supply is a proxy for fresh on-chain dollar liquidity. $${PRICES.stablecoin_supply}/call.`, inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("How many stablecoins in items[], default 25") }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./macro.js")).stablecoinSupply(a)); } catch (e) { return fail(e); } });
    s.registerTool("treasury_auctions", { title: "U.S. Treasury auctions", description: `Recent U.S. Treasury auction results (high yield, bid-to-cover, indirect/direct/primary-dealer share) and upcoming auctions with size, from public-domain Fiscal Data. $${PRICES.treasury_auctions}/call.`, inputSchema: { days: z.number().int().min(1).max(90).optional(), type: z.enum(["Bill", "Note", "Bond", "TIPS", "FRN", "CMB"]).optional() }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./macro.js")).treasuryAuctions(a)); } catch (e) { return fail(e); } });
    s.registerTool("defi_yields", { title: "DeFi yields", description: `Stablecoin (or all) DeFi pools above a TVL floor with APY, 30-day mean APY, share paid in reward tokens and DefiLlama outlier flag. Not a risk rating. $${PRICES.defi_yields}/call.`, inputSchema: { min_tvl: z.number().optional(), stable_only: z.boolean().optional(), chain: z.string().optional(), limit: z.number().int().min(1).max(200).optional(), include_extreme: z.boolean().optional() }, annotations: ro },
      async (a: any) => { try { return json(await (await import("./macro.js")).defiYields(a)); } catch (e) { return fail(e); } });
  }
  s.registerTool("polymarket_top", {
    title: "Polymarket top markets", description: `The most active Polymarket markets right now (by 24h volume, liquidity or 24h change; optional tag like crypto/fed/politics): question, YES odds, 24h change, volume, liquidity, end date, and a link to our primary-source evidence pack for each. Use it to find where prediction-market money is moving before calling polymarket_context. $${PRICES.polymarket_top}/call.`,
    inputSchema: PolyTopArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await polymarketTop(PolyTopArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("derivs_for", {
    title: "Perp derivatives for coin", description: `Perpetual-futures microstructure for ONE coin from Hyperliquid's public API (no key): hourly funding with 8h-equivalent and annualized %, predicted next funding per venue (Hyperliquid, Binance, Bybit…), open interest in coins and USD with OI-to-24h-volume, mark/oracle/mid and premium vs oracle, 24h notional volume and change, and flags (funding_hot_long/short, premium_rich/discount, oi_heavy_vs_volume). Joined with our primary-source event pressure on the same asset when covered. Use it before sizing a perp position, to detect crowded funding, or as the market-structure leg next to events_since. Liquidations are not included. $${PRICES.derivs_for}/call.`,
    inputSchema: DerivsArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await derivsFor(DerivsArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("news_for", {
    title: "News for asset", description: `Headlines that touch ONE asset in the window (press wires, corporate releases, halts, hacks, media), each with source tier, corroboration count, a −1..1 heuristic sentiment score and the asset's impact direction, plus an average sentiment label. Links to the original items; no article bodies. Use it to answer "what is the news flow on X today" or to feed a sentiment gate. $${PRICES.news_for}/call.`,
    inputSchema: NewsArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(newsFor(NewsArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("filings_for", {
    title: "SEC filings for issuer", description: `SEC EDGAR filings that touch ONE US issuer in the window: 8-K by item (material agreements, results, departures), Form 4 insider trades, 13D/G activist stakes, S-1/424B offerings, bankruptcy — with summary, impact direction and link to the filing. Public-domain source. Use it before earnings or when a stock moves without news. $${PRICES.filings_for}/call.`,
    inputSchema: FilingsArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(filingsFor(FilingsArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("calendar", {
    title: "Catalyst calendar", description: `Upcoming scheduled catalysts for the next N days: US macro prints (CPI, PPI, jobs, PCE, GDP, retail, JOLTS) with ET times, FOMC decisions and minutes, Treasury auctions and earnings dates seen in the feed, each with the assets it usually moves. Use it to avoid holding through a print or to schedule polling. $${PRICES.calendar}/call.`,
    inputSchema: CalendarArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(calendar(CalendarArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("oracle_forecast", {
    title: "Oracle: forecast a binary question (async)", description: `Get a CALIBRATED probability for a yes/no market question — e.g. "Will Bitcoin close above 120,000 USD on 2026-10-31?", "Will the Fed cut at the October FOMC?", "Will ETH touch 5,000 before 2026-10-31?". The oracle first assembles live context from Intel (spot, 30d realized vol, funding, OI, Polymarket odds, calendar, recent primary-source events) and computes a volatility base rate; then runs Monte Carlo simulations of LLM agent societies (distinct personas, social graph, optional news shocks) plus a 5-expert panel anchored on the base rate; a reasoning model aggregates with the rule "0.5 is never a default". ASYNC: this call returns { forecast_id, status: "queued", eta_s } in under a second; poll oracle_get(forecast_id) every ~20 s (free) until status = "done" (1–3 min). Result: probability, ci80, disagreement, base_rate, market_odds, edge (probability − market), drivers, failure_modes, confidence, runs[] with belief trajectories, panel[], commitment_hash (sha256 committed before resolution), context_used. Public Brier record: oracle_track_record. $${PRICES.oracle_forecast}/call (covers ~70 LLM calls). Optional interventions=[{round, news, audience}] inject a shock into the simulated society.`,
    inputSchema: ForecastRequest.shape, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (a) => {
    try {
      if (!llmConfigured()) return fail(new Error("oracle temporarily unavailable: LLM backend not configured"));
      const r = ForecastRequest.parse(a);
      const job = enqueueForecast(r, "mcp");
      return json({ ...job, question: r.question, config: { runs: r.runs, population: r.population, rounds: r.rounds }, next: `call oracle_get with forecast_id=${job.forecast_id} in ~${Math.min(60, job.eta_s)} s`, disclaimer: DISCLAIMER });
    } catch (e) { return fail(e); }
  });

  s.registerTool("oracle_get", {
    title: "Oracle: fetch a forecast by id (free)", description: `Poll or retrieve an oracle forecast. While the job runs: { status: "queued"|"running", retry_after_s }. When done: the full Forecast (probability, ci80, disagreement, base_rate, market_odds, edge, summary, drivers, failure_modes, confidence, runs[], panel[], commitment_hash, context_used). Free — results are yours forever; anyone can verify the commitment_hash. Use after oracle_forecast, or with an id from oracle_board / oracle_track_record.`,
    inputSchema: { forecast_id: z.string().min(6).describe("The forecast_id returned by oracle_forecast or listed by oracle_board / oracle_track_record.") }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    try {
      const id = String(a.forecast_id);
      const f = getForecast(id); if (f) return json({ status: "done", ...f });
      const j = getJob(id); if (!j) return fail(new Error("unknown forecast_id"));
      if (j.status === "failed") return json({ status: "failed", forecast_id: id, error: j.error });
      return json({ status: j.status, forecast_id: id, created_at: j.created_at, queue: { active: _queue.active, pending: _queue.pending }, retry_after_s: 20 });
    } catch (e) { return fail(e); }
  });

  s.registerTool("polymarket_edge", {
    title: "Polymarket edge (oracle vs market)", description: `Where a calibrated forecaster disagrees most with Polymarket right now: for each open daily-board question matched to a Polymarket market, the oracle probability, 80% interval, market YES price, edge (p − odds), which side looks cheap, base rate, resolution date and a sha256 commitment hash — sorted by |edge|. Cached from the daily board (no LLM, instant); poll it in a loop. Public Brier track record at /v1/oracle/track-record. $${PRICES.polymarket_edge}/call.`,
    inputSchema: { min_abs: z.number().min(0).max(1).optional().describe("Minimum |p − odds|, e.g. 0.03"), limit: z.number().int().min(1).max(50).optional() }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { const { polymarketEdge } = await import("./oracle-routes.js"); return json({ as_of: new Date().toISOString(), ...polymarketEdge(a.min_abs ?? 0, a.limit ?? 20) }); } catch (e) { return fail(e); } });

  s.registerTool("oracle_board", {
    title: "Oracle: daily board of standing forecasts", description: `The oracle's standing questions recomputed daily (BTC/ETH/SOL vs price targets, next FOMC decision, most-traded Polymarket markets, upcoming CPI/NFP): for each, probability, 80% interval, base rate, market odds, edge and commitment hash — no waiting, no LLM call, cached. Pass slug to get one forecast with full drivers/failure modes and its history. Poll in a loop for cheap calibrated priors. $${PRICES.oracle_board}/call.`,
    inputSchema: { slug: z.string().optional().describe("Optional board slug, e.g. btc-120k-oct31. Omit for the whole board.") }, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => {
    try {
      if (a.slug) { const items = boardLatest().filter(i => i.slug === a.slug); if (!items.length) return fail(new Error(`unknown board slug ${a.slug}`)); const f = getForecast(items[0].id); return json({ slug: a.slug, ...f }); }
      const items = boardLatest();
      return json({ as_of: new Date().toISOString(), count: items.length, items, disclaimer: DISCLAIMER });
    } catch (e) { return fail(e); }
  });

  s.registerTool("oracle_track_record", {
    title: "Oracle: public Brier track record (free)", description: `How good the oracle has been: Brier score overall and by domain (0.25 = coin flip, 0.15 = good human forecaster, 0.10 = superforecaster), oracle vs. market Brier and beat_market_rate on questions that had a Polymarket price, mean absolute edge, and the 20 most recent commitments (id, probability, hash, outcome). Free. Use it to decide how much to trust oracle_forecast / oracle_board.`,
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => { try { return json({ ...trackRecord(), recent: recentForecasts(20), disclaimer: DISCLAIMER }); } catch (e) { return fail(e); } });

  s.registerTool("brief", {
    title: "Pre-trade brief (premium)", description: `One-call briefing for ONE asset, everything an operator reads before trading it: net pressure and drivers (24h), headlines with sentiment, recent SEC filings (equities), first-order exposure map, related Polymarket market with odds, upcoming scheduled catalysts (7d) and venue status / tradable_now. Replaces 6 separate calls; ideal once per asset per session or pre-open. $${PRICES.brief}/call.`,
    inputSchema: BriefArgs.shape, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async (a) => { try { return json(await brief(BriefArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("universe", {
    title: "Universe", description: "List every asset id the service scores (top-100 US equities by volume, indices/ETFs, 15 crypto, commodities, FX, rates) with class, name and exposure tags, plus the universe version stamped on every response. Call it once to map your tickers to asset ids before using the other tools. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => json(universe()));

  s.registerTool("sources_status", {
    title: "Sources status", description: "Transparency report on the ~40 data connectors: tier (primary/media), cadence, last successful run, items ingested, last error. Use it to judge freshness before trusting a quiet feed, or to see which sources are best-effort. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async () => json(sources()));

  // ---- Carry Oracle (subscription, flat US$100/month): the tools answer subscription_required without a live dsi_carry_ key.
  const isTrial = (k?: string) => { if (!k) return false; const v = validateKey(k); return Boolean(v && String(v.plan) === "trial" && v.remaining >= 1); };
  const carryGuard = (fn: () => unknown) => {
    const ok = ctx.operator || ctx.carryPaid || carryAccess(ctx.carryKey).ok || isTrial(ctx.carryKey);
    if (!ok) return json({ error: "subscription_required", product: "Carry Oracle", price: `US$${CARRY.usd_month}/month flat, unlimited calls`, pay_card: "https://intel.degenscan.io/v1/carry/checkout", pay_usdc: "POST https://intel.degenscan.io/v1/keys/x402/carry_month (x402, 100 USDC = 30 days)", then: "send X-API-KEY: dsi_carry_… on the MCP request — or pay this call with x402 (USDC)", docs: "https://intel.degenscan.io/docs/carry", disclaimer: "Market data and analytics only — not a signal, not investment advice." });
    try { return json({ ...(fn() as object), disclaimer: "Market data and analytics only — not a signal, not investment advice." }); } catch (e) { return fail(e); }
  };
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  s.registerTool("keys_trial", { title: "Get a free trial key", description: `Free trial API key for Degenscan Intel: ${TRIAL.calls} calls, ${TRIAL.days} days, no card. Covers the Carry Data tools (carry_*) and the event feed; not the oracle. Then send it as X-API-KEY. One per e-mail.`, inputSchema: { email: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    async (a: any) => { const r = createTrialKey(String(a.email ?? ""), createHash("sha256").update(String(ctx.ip ?? "mcp")).digest("hex").slice(0, 16)); return "error" in r ? json({ error: r.error, subscribe: "https://intel.degenscan.io/carry" }) : json({ api_key: r.key, calls: TRIAL.calls, expires_at: r.expires_at, usage: "send X-API-KEY on REST or MCP requests" }); });
  s.registerTool("carry_funding_matrix", { title: "Carry: funding matrix", description: "Current annualised funding for every perp on every Hyperliquid dex (main + HIP-3), with OI, 24h volume and spot mark when it exists. Data, not a signal. Requires a Carry Oracle key (US$100/month).", inputSchema: { dex: z.string().optional().describe("Filter to one dex: main, xyz, io, para, mkts…"), min_vol: z.number().optional().describe("Minimum 24h volume in USD, default 0") }, annotations: ro }, async (a: any) => carryGuard(() => fundingMatrix({ dex: a.dex, minVol: a.min_vol ?? 0 })));
  s.registerTool("carry_xdex", { title: "Carry: cross-dex spreads", description: "Assets listed on two or more Hyperliquid HIP-3 dexes (xyz, io, para, mkts…), e.g. NBIS on xyz and io. Returns items[] with base, legs[] (coin, dex, funding_apr now, funding_apr_14d, hours_positive_14d, vol24_usd, oi_usd, mark), spread_apr_now and spread_apr_14d (highest minus lowest leg, annualised), basis_pct (mark difference between legs, %), min_leg_vol24_usd; sorted by 14-day spread. Main-dex tickers are excluded because they can be different assets. Data, not a signal. Requires a Carry key, the free trial key, or x402 per call.", inputSchema: { min_vol: z.number().optional().describe("Minimum 24h volume per leg in USD, default 100000"), limit: z.number().optional().describe("Max rows, default 50") }, annotations: ro }, async (a: any) => carryGuard(() => crossDex({ minVol: a.min_vol ?? 100_000, limit: a.limit ?? 50 })));
  s.registerTool("carry_spot_perp", { title: "Carry: spot × perp", description: "Hyperliquid main-dex perps that also have a Hyperliquid spot market (e.g. HYPE, PURR, BTC via UBTC). Returns items[] with base, perp, funding_apr (annualised, now), funding_apr_14d (14-day mean), hours_positive_14d (share of hours with positive funding, 0–1), perp_mark, spot_mark, spot_pair, basis_pct (perp vs spot, %), perp_vol24_usd, spot_vol24_usd, oi_usd, sorted by 14-day funding. Data, not a signal. Requires a Carry key (X-API-KEY), the free trial key, or x402 per call.", inputSchema: { min_vol: z.number().optional().describe("Minimum perp 24h volume in USD, default 100000"), limit: z.number().optional().describe("Max rows, default 50") }, annotations: ro }, async (a: any) => carryGuard(() => spotPerp({ minVol: a.min_vol ?? 100_000, limit: a.limit ?? 50 })));
  s.registerTool("carry_history", { title: "Carry: funding history", description: "Hourly funding/premium/mark/OI/volume for one coin, kept beyond Hyperliquid's 500 h window. HIP-3 coins are prefixed (xyz:NBIS). Requires a Carry Oracle key.", inputSchema: { coin: z.string().describe("Hyperliquid coin: BTC, ETH… or HIP-3 dex:coin, e.g. xyz:NBIS"), hours: z.number().optional().describe("Hours of history, default 720") }, annotations: ro }, async (a: any) => carryGuard(() => coinHistory(a.coin, a.hours ?? 720)));
  s.registerTool("carry_naked", { title: "Carry: unhedgeable funding extremes", description: "Perps whose |annualised funding| exceeds a threshold (default 50%) and that have no hedge leg on Hyperliquid (no spot, no same-ticker HIP-3 listing). Raw data, not a call. Requires a Carry Oracle key.", inputSchema: { min_abs_apr: z.number().optional().describe("Threshold on |annualised funding| as a fraction, default 0.5 = 50%") }, annotations: ro }, async (a: any) => carryGuard(() => naked({ minAbsApr: a.min_abs_apr ?? 0.5 })));
  {
    const A = () => import("../carry/analytics.js");
    const cg = async (fn: () => any) => { let v: any; try { v = await fn(); } catch (e) { return fail(e); } return carryGuard(() => v ?? { error: "not found" }); };
    s.registerTool("carry_regime", { title: "Carry: funding regime", description: `Per Hyperliquid market (or one coin): % of hours at the 10.95 %/yr floor, in premium, negative or zero over N days, regime now, counts by dex. $${PRICES.carry_regime}/call or Carry key.`, inputSchema: { coin: z.string().optional().describe("Optional coin, HIP-3 prefixed (xyz:NBIS)"), days: z.number().int().min(1).max(90).optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).regime(a)));
    s.registerTool("carry_calendar", { title: "Carry: weekday calendar", description: `Funding APR by UTC weekday per dex (or one coin), weekday vs weekend, collapses_on_weekend. $${PRICES.carry_calendar}/call or Carry key.`, inputSchema: { dex: z.string().optional(), coin: z.string().optional(), days: z.number().int().min(7).max(120).optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).calendar(a)));
    s.registerTool("carry_oracle_health", { title: "Carry: oracle health", description: `Flags: frozen_funding (0.0 for ≥ 4 h), stale_oracle, divergent_vs_peer (HIP-3 legs, z-score). $${PRICES.carry_oracle_health}/call or Carry key.`, inputSchema: { hours: z.number().int().min(12).max(720).optional(), dex: z.string().optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).oracleHealth(a)));
    s.registerTool("carry_extremes", { title: "Carry: funding extremes", description: `Funding extremes (|APR| ≥ min_abs_apr, default 2 = 200 %) with realized 24h/7d/14d averages and hours in extreme. $${PRICES.carry_extremes}/call or Carry key.`, inputSchema: { min_abs_apr: z.number().optional(), limit: z.number().int().optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).extremes({ minAbsApr: a.min_abs_apr, limit: a.limit })));
    s.registerTool("carry_aftermath", { title: "Carry: after funding extremes", description: `Past extreme episodes: onset, hours above threshold, half-life, price return and funding accrued 4/12/24 h later. $${PRICES.carry_aftermath}/call or Carry key.`, inputSchema: { min_abs_apr: z.number().optional(), days: z.number().int().min(3).max(120).optional(), coin: z.string().optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).aftermath({ minAbsApr: a.min_abs_apr, days: a.days, coin: a.coin })));
    s.registerTool("carry_breakeven", { title: "Carry: break-even", description: `Round-trip cost (2 legs × open/close), break-even days and net return on margin for a funding spread; modes taker / maker1 / maker2; slippage assumed (0.2 % taker, 0.1 % maker) unless given. $${PRICES.carry_breakeven}/call or Carry key.`, inputSchema: { spread_apr: z.number().describe("Decimal, 0.35 = 35 %/yr"), lev: z.number().optional(), mode: z.enum(["taker", "maker1", "maker2"]).optional(), slippage_taker_pct: z.number().optional(), slippage_maker_pct: z.number().optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).breakeven(a)));
    s.registerTool("carry_depth", { title: "Carry: book depth history", description: `Hourly order-book depth (USD at 5/10/20/50 bps per side) and spread for one of the 40 most traded perps. $${PRICES.carry_depth}/call or Carry key.`, inputSchema: { coin: z.string(), hours: z.number().int().min(1).max(2160).optional() }, annotations: ro }, async (a: any) => cg(async () => (await A()).depth(a.coin, a.hours)));
  }
  s.registerTool("carry_watchdog", { title: "Carry: market health", description: "Every Hyperliquid perp market and dex: status (active/zero_oi/delisted), OI and volume with 7-day change, growth mode, risk flags. Requires a Carry Oracle key.", inputSchema: {}, annotations: ro }, async () => carryGuard(() => watchdog()));

  return s;
}
