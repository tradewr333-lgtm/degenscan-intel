import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TokenVerdictArgs, tokenVerdict } from "./token-verdict.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, PolymarketContextArgs, NewsArgs, FilingsArgs, CalendarArgs, BriefArgs, DerivsArgs, PriceArgs, FundingAlertsArgs, WhaleArgs, PolyTopArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, polymarketContext, pulse, newsFor, filingsFor, calendar, brief, derivsFor, priceFor, fundingAlerts, whaleMoves, polymarketTop } from "./tools.js";
import { PRICES } from "./pricing.js";
import { ForecastRequest, DISCLAIMER } from "../oracle/schema.js";
import { enqueueForecast, _queue } from "../oracle/queue.js";
import { boardLatest, getForecast, getJob, recentForecasts, trackRecord } from "../oracle/ledger.js";
import { llmConfigured } from "../oracle/llm.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }], structuredContent: x as Record<string, unknown> });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true });

/** Build the MCP server. One instance per stateless HTTP request is fine (cheap). */
export function buildMcpServer() {
  const s = new McpServer({ name: "degenscan-intel", version: "0.10.11" }, {
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

  return s;
}
