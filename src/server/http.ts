import { randomBytes } from "node:crypto";
import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { PRICES } from "./pricing.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, PolymarketContextArgs, NewsArgs, FilingsArgs, CalendarArgs, BriefArgs, DerivsArgs, PriceArgs, FundingAlertsArgs, WhaleArgs, PolyTopArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, polymarketContext, pulse, newsFor, filingsFor, calendar, brief, derivsFor, priceFor, fundingAlerts, whaleMoves, polymarketTop, TOOL_DOCS } from "./tools.js";
import { CONNECTORS } from "../ingest/registry.js";
import { DB_PATH, getDb, recordCall, weeklyMetrics } from "../store/db.js";
import { decideAccess, toolForRequest, FREE_MODE, type Access } from "./access.js";
import { PACKS, CARRY, CARRY_DESK, deskSeats, setCarrySetting, deskAccess, createPackKey, createCarryKey, carryAccess, activatePackKey, dropPendingKey, keyStatus, type Pack } from "./keys.js";
import { installX402, PAY_TO_SOLANA, SOLANA_NETWORK } from "./x402v2.js";
import { installDocs } from "./docs.js";
import { installOracleRoutes } from "./oracle-routes.js";
import { installAppRoutes } from "./app-routes.js";
import { carryStats, fundingMatrix, crossDex, coinHistory, spotPerp, naked, watchdog, ensureWaitlist } from "../carry/hl.js";
import { createHash as _ch } from "node:crypto";
import { installHelpRoutes } from "./help-page.js";
import { FastifyAdapter } from "@x402/fastify";
import { installStripe } from "./stripe.js";
import { TokenVerdictArgs, tokenVerdict } from "./token-verdict.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

declare module "fastify" { interface FastifyRequest { intelAccess?: Access; pendingKeyId?: string; purchasedPack?: Pack | "carry_month" } }

const OPERATOR = "Marbella Collins LLC (Florida, USA) — contact@degenscan.io";
const DISCLAIMER = "Information and analytics only — not investment advice. Impact scores are deterministic heuristics over public events, with no guarantee of accuracy or timeliness. You are solely responsible for your trading decisions.";
const METRICS_SINCE = process.env.METRICS_SINCE ?? "2026-09-27T00:00:00Z";
/** Owner/test wallets: never counted as customers or revenue in public metrics. */
const EXCLUDED_WALLETS = (process.env.EXCLUDED_WALLETS ?? "0x5344722b8D037827A9a5b7cD6312481D215d33BF,0x21f4A2DA07bccE60878cAb223358D11aD8F11a94").split(",").map(s => s.trim()).filter(Boolean);

const REST_FOR: Record<string, string> = { events_since: "/v1/events?since=4h&universe=NVDA,BTC", impact_for: "/v1/impact/{asset_id}?since=24h", exposure_graph: "/v1/graph/{asset_id}?depth=2", regime_snapshot: "/v1/regime", explain: "/v1/explain/{event_id}", polymarket_context: "/v1/polymarket/{market}?since=48h", pulse: "/v1/pulse", news_for: "/v1/news/{ticker}?since=24h", derivs_for: "/v1/derivs/{symbol}", price_for: "/v1/price/{symbol}", funding_alerts: "/v1/funding/alerts", whale_moves: "/v1/whales?min_usd=1000000", polymarket_top: "/v1/polymarket/top?sort=volume_24h", filings_for: "/v1/filings/{ticker}?since=7d", calendar: "/v1/calendar?days=7", brief: "/v1/brief/{asset_id}", token_verdict: "/v1/token/verdict/{address}?chain=base", oracle_board: "/v1/oracle/board", polymarket_edge: "/v1/oracle/edge?min_abs=0.02", oracle_forecast: "/v1/oracle/forecast" };
const OPENAPI = (base: string) => ({
  openapi: "3.1.0",
  info: { title: "Degenscan Intel", version: "0.10.33", description: "Cross-asset market event intelligence for AI trading agents. Priced routes return HTTP 402 with x402 v2 payment requirements (USDC on Base) unless X-API-KEY is sent or the free trial header X-Free-Trial: 1 is present (100 calls/day/IP). Information and analytics only — not investment advice.", contact: { name: "Marbella Collins LLC", email: "contact@degenscan.io" }, license: { name: "MIT" } },
  servers: [{ url: base }],
  components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-KEY" }, freeTrial: { type: "apiKey", in: "header", name: "X-Free-Trial", description: "Send the value 1 for 100 free calls/day per IP." }, x402: { type: "apiKey", in: "header", name: "PAYMENT-SIGNATURE", description: "x402 v2 payment payload (base64). Obtain requirements from the 402 response header PAYMENT-REQUIRED." } } },
  paths: {
    "/v1/events": { get: { summary: "Events since t that touch a universe, scored into per-asset impacts", "x-price-usd": PRICES.events_since, parameters: [
      { name: "since", in: "query", schema: { type: "string", default: "4h" }, description: "30m | 4h | 2d | ISO-8601 (past values = backtest)" }, { name: "universe", in: "query", schema: { type: "string" }, description: "comma-separated asset ids, e.g. NVDA,BTC,CL" },
      { name: "kinds", in: "query", schema: { type: "string" } }, { name: "min_severity", in: "query", schema: { type: "number" } }, { name: "min_confidence", in: "query", schema: { type: "number" } }, { name: "q", in: "query", schema: { type: "string" } }, { name: "limit", in: "query", schema: { type: "integer", default: 50 } } ],
      responses: { "200": { description: "events[] with impacts[]" }, "402": { description: "x402 payment required (header PAYMENT-REQUIRED)" } } } },
    "/v1/impact/{asset_id}": { get: { summary: "Net directional pressure on one asset + source events", "x-price-usd": PRICES.impact_for, parameters: [{ name: "asset_id", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", schema: { type: "string", default: "24h" } }], responses: { "200": { description: "bias, n_events, drivers, events" }, "402": { description: "payment required" } } } },
    "/v1/graph/{asset_id}": { get: { summary: "Exposure sub-graph around an asset", "x-price-usd": PRICES.exposure_graph, parameters: [{ name: "asset_id", in: "path", required: true, schema: { type: "string" } }, { name: "depth", in: "query", schema: { type: "integer", default: 2, minimum: 1, maximum: 3 } }], responses: { "200": { description: "nodes, edges, facilities" }, "402": { description: "payment required" } } } },
    "/v1/regime": { get: { summary: "Venues open, 24h pressure ranking, top events, prediction markets", "x-price-usd": PRICES.regime_snapshot, responses: { "200": { description: "snapshot" }, "402": { description: "payment required" } } } },
    "/v1/explain/{event_id}": { get: { summary: "Rationale for one event's impacts", "x-price-usd": PRICES.explain, parameters: [{ name: "event_id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "explanation" }, "402": { description: "payment required" } } } },
    "/v1/polymarket/{market}": { get: { summary: "Evidence pack for one Polymarket market: current odds + primary-source events in our feed that bear on the question", "x-price-usd": PRICES.polymarket_context, parameters: [{ name: "market", in: "path", required: true, schema: { type: "string" }, description: "market id, slug, or question text" }, { name: "since", in: "query", schema: { type: "string", default: "48h" } }, { name: "limit", in: "query", schema: { type: "integer", default: 15 } }], responses: { "200": { description: "market, query_terms, related[]" }, "402": { description: "payment required" } } } },
    "/v1/pulse": { get: { summary: "Last-hour event counts by class, top-3 severe events, venues open — cheapest probe", "x-price-usd": PRICES.pulse, responses: { "200": { description: "pulse" }, "402": { description: "payment required" } } } },
    "/v1/token/verdict/{address}": { get: { summary: "Token contract risk verdict (honeypot, taxes, mint/pause/blacklist, owner, holder concentration, LP lock, DEX liquidity) — EVM chains + Solana", "x-price-usd": PRICES.token_verdict, parameters: [{ name: "address", in: "path", required: true, schema: { type: "string" } }, { name: "chain", in: "query", schema: { type: "string", default: "base" } }], responses: { "200": { description: "verdict, score, flags[], contract, holders, market" }, "402": { description: "payment required" } } } },
    "/v1/price/{symbol}": { get: { summary: "Price probe (no key): Hyperliquid mark/mid/oracle + Coinbase spot, 24h change, basis, funding", "x-price-usd": PRICES.price_for, parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "perp, spot, basis_pct, related" }, "402": { description: "payment required" } } } },
    "/v1/funding/alerts": { get: { summary: "Coins with extreme perp funding now (Hyperliquid) + predicted funding per venue", "x-price-usd": PRICES.funding_alerts, parameters: [{ name: "min_abs_rate_1h", in: "query", schema: { type: "number", default: 0.0003 } }, { name: "limit", in: "query", schema: { type: "integer", default: 15 } }], responses: { "200": { description: "alerts[]" }, "402": { description: "payment required" } } } },
    "/v1/whales": { get: { summary: "Large USDC/USDT transfers on Base and Ethereum (public explorers, no key) with exchange labels and flow tags", "x-price-usd": PRICES.whale_moves, parameters: [{ name: "min_usd", in: "query", schema: { type: "number", default: 1000000 } }, { name: "chains", in: "query", schema: { type: "string" }, description: "base,ethereum" }, { name: "limit", in: "query", schema: { type: "integer", default: 25 } }], responses: { "200": { description: "moves[], totals_usd" }, "402": { description: "payment required" } } } },
    "/v1/polymarket/top": { get: { summary: "Most active Polymarket markets now: YES odds, 24h change, volume, liquidity, evidence link", "x-price-usd": PRICES.polymarket_top, parameters: [{ name: "sort", in: "query", schema: { type: "string", enum: ["volume_24h", "liquidity", "change_24h"], default: "volume_24h" } }, { name: "limit", in: "query", schema: { type: "integer", default: 20 } }, { name: "tag", in: "query", schema: { type: "string" } }], responses: { "200": { description: "markets[]" }, "402": { description: "payment required" } } } },
    "/v1/derivs/{symbol}": { get: { summary: "Perp microstructure for one coin (Hyperliquid public API): funding, predicted funding by venue, open interest, premium, 24h volume, flags + our event pressure", "x-price-usd": PRICES.derivs_for, parameters: [{ name: "symbol", in: "path", required: true, schema: { type: "string" }, description: "BTC, ETH, SOL, HYPE…" }, { name: "since", in: "query", schema: { type: "string", default: "24h" } }], responses: { "200": { description: "price, funding, open_interest, volume_24h_usd, flags, event_pressure" }, "402": { description: "payment required" } } } },
    "/v1/news/{ticker}": { get: { summary: "Headlines touching one asset with tier, corroboration and heuristic sentiment", "x-price-usd": PRICES.news_for, parameters: [{ name: "ticker", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", schema: { type: "string", default: "24h" } }, { name: "limit", in: "query", schema: { type: "integer", default: 25 } }], responses: { "200": { description: "items[], sentiment_avg" }, "402": { description: "payment required" } } } },
    "/v1/filings/{ticker}": { get: { summary: "SEC EDGAR filings touching one issuer (8-K, Form 4, 13D/G, S-1)", "x-price-usd": PRICES.filings_for, parameters: [{ name: "ticker", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", schema: { type: "string", default: "7d" } }, { name: "forms", in: "query", schema: { type: "string" }, description: "comma-separated: 8k,insider,activist,offering,bankruptcy" }], responses: { "200": { description: "filings[]" }, "402": { description: "payment required" } } } },
    "/v1/calendar": { get: { summary: "Upcoming US macro prints, FOMC, auctions and earnings (N days)", "x-price-usd": PRICES.calendar, parameters: [{ name: "days", in: "query", schema: { type: "integer", default: 7 } }, { name: "types", in: "query", schema: { type: "string" }, description: "comma-separated: macro,fomc,earnings,auctions" }, { name: "universe", in: "query", schema: { type: "string" } }], responses: { "200": { description: "items[]" }, "402": { description: "payment required" } } } },
    "/v1/brief/{asset_id}": { get: { summary: "Premium one-call pre-trade briefing for an asset (pressure, headlines, filings, exposure, prediction market, catalysts, venues)", "x-price-usd": PRICES.brief, parameters: [{ name: "asset_id", in: "path", required: true, schema: { type: "string" } }, { name: "since", in: "query", schema: { type: "string", default: "24h" } }], responses: { "200": { description: "brief" }, "402": { description: "payment required" } } } },
    "/v1/oracle/forecast": { post: { summary: "Oracle: calibrated YES-probability for a binary question (async job). Monte Carlo of LLM agent societies + base-rate-anchored expert panel, grounded in live Intel data. Returns 202 + forecast_id; poll GET /v1/oracle/forecast/{id} (free).", "x-price-usd": PRICES.oracle_forecast,
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["question"], properties: { question: { type: "string", example: "Will Bitcoin close above 120,000 USD on 2026-10-31?" }, resolves_at: { type: "string", format: "date-time" }, context: { type: "string" }, runs: { type: "integer", default: 8, maximum: 12 }, population: { type: "integer", default: 24, maximum: 48 }, rounds: { type: "integer", default: 3, maximum: 6 }, interventions: { type: "array", items: { type: "object", properties: { round: { type: "integer" }, news: { type: "string" }, audience: { type: "string", enum: ["all", "half", "influencers", "skeptics"] } } } }, method: { type: "string", enum: ["social_sim", "expert_panel", "hybrid"] } } } } } },
      responses: { "202": { description: "{ forecast_id, status: queued, eta_s, poll }" }, "402": { description: "payment required ($0.25)" } } } },
    "/v1/oracle/forecast/{id}": { get: { summary: "Oracle: poll a forecast job (free). done → probability, ci80, disagreement, base_rate, market_odds, edge, drivers, failure_modes, runs[], panel[], commitment_hash", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "status queued|running|failed|done (+Forecast)" }, "404": { description: "unknown id" } } } },
    "/v1/oracle/edge": { get: { summary: "Polymarket edge: open board questions where the oracle disagrees most with the market, sorted by |p − odds| (cached, no LLM)", "x-price-usd": PRICES.polymarket_edge, parameters: [{ name: "min_abs", in: "query", schema: { type: "number" } }, { name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "items[]" }, "402": { description: "payment required" } } } },
    "/v1/oracle/board": { get: { summary: "Oracle: daily board of standing forecasts (cached, no LLM) — probability, interval, base rate, market odds, edge per question", "x-price-usd": PRICES.oracle_board, responses: { "200": { description: "items[]" }, "402": { description: "payment required" } } } },
    "/v1/oracle/board/{slug}": { get: { summary: "Oracle: one board forecast with full payload and history", "x-price-usd": PRICES.oracle_board, parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Forecast + history[]" }, "402": { description: "payment required" } } } },
    "/v1/oracle/track-record": { get: { summary: "Oracle: public Brier track record overall, by domain and vs. market (free)", responses: { "200": { description: "brier, vs_market, by_domain, recent[]" } } } },
    "/v1/universe": { get: { summary: "Asset universe (free)", responses: { "200": { description: "assets[]" } } } },
    "/v1/sources": { get: { summary: "Connector health (free)", responses: { "200": { description: "sources[]" } } } },
    "/v1/carry/stats": { get: { summary: "Carry Oracle dataset size, tiers and links (free)", responses: { "200": { description: "funding rows, coins, dexes, first/last hour, tiers" } } } },
    "/v1/carry/funding-matrix": { get: { summary: "Carry Oracle: annualised funding for every perp on every Hyperliquid dex (subscription: X-API-KEY dsi_carry_, US$100/month)", security: [{ apiKey: [] }], parameters: [{ name: "dex", in: "query", schema: { type: "string" } }, { name: "min_vol", in: "query", schema: { type: "number" } }], responses: { "200": { description: "items[] {coin, dex, base, funding_1h, funding_apr, mark, oi_usd, vol24_usd, spot}" }, "402": { description: "subscription required — how to pay" } } } },
    "/v1/carry/xdex": { get: { summary: "Carry Oracle: same ticker on 2+ HIP-3 dexes — funding spread now/14d, % positive hours, basis, liquidity (subscription)", security: [{ apiKey: [] }], parameters: [{ name: "min_vol", in: "query", schema: { type: "number" } }, { name: "limit", in: "query", schema: { type: "number" } }], responses: { "200": { description: "items[] {base, legs[], spread_apr_now, spread_apr_14d, basis_pct, min_leg_vol24_usd}" }, "402": { description: "subscription required" } } } },
    "/v1/carry/spot-perp": { get: { summary: "Carry Oracle: main-dex perp vs spot — funding now/14d, % positive hours, basis (subscription)", security: [{ apiKey: [] }], responses: { "200": { description: "items[] {base, perp, funding_apr, funding_apr_14d, hours_positive_14d, perp_mark, spot_mark, basis_pct}" }, "402": { description: "subscription required" } } } },
    "/v1/carry/history/{coin}": { get: { summary: "Carry Oracle: hourly funding/premium/mark/OI/volume for one coin, beyond Hyperliquid's 500 h (subscription)", security: [{ apiKey: [] }], parameters: [{ name: "coin", in: "path", required: true, schema: { type: "string" }, example: "xyz:NBIS" }, { name: "hours", in: "query", schema: { type: "number" } }], responses: { "200": { description: "items[] hourly" }, "402": { description: "subscription required" } } } },
    "/v1/carry/naked": { get: { summary: "Carry Oracle: funding extremes with no hedge leg on Hyperliquid — raw data (subscription)", security: [{ apiKey: [] }], parameters: [{ name: "min_abs_apr", in: "query", schema: { type: "number", default: 0.5 } }], responses: { "200": { description: "items[] {coin, dex, funding_apr_now, funding_apr_14d, hours_above_threshold_14d, why_no_hedge}" }, "402": { description: "subscription required" } } } },
    "/v1/carry/watchdog": { get: { summary: "Carry Oracle: health of every market and dex (subscription)", security: [{ apiKey: [] }], responses: { "200": { description: "dexes[], markets[] {status, oi_usd, oi_change_7d_pct, vol24h_usd, growth_mode, risk_flags}" }, "402": { description: "subscription required" } } } },
    "/v1/keys/x402/carry_month": { post: { summary: "Carry Oracle: 30 days of unlimited access for 100 USDC (x402, Base or Solana)", responses: { "200": { description: "api_key dsi_carry_…" }, "402": { description: "x402 payment requirements" } } } },
    "/v1/metrics": { get: { summary: "Public weekly usage metrics (free)", responses: { "200": { description: "weeks[]" } } } },
    "/v1/keys/x402/{pack}": { post: { summary: "Buy a prepaid API key with USDC (x402) — no human, no card", parameters: [{ name: "pack", in: "path", required: true, schema: { type: "string", enum: ["pack_1k", "pack_10k", "pack_100k"] } }], responses: { "200": { description: "{ api_key, calls }" }, "402": { description: "x402 payment required: $5 / $40 / $300" } } } },
    "/v1/keys/me": { get: { summary: "Remaining budget for X-API-KEY (free)", security: [{ apiKey: [] }], responses: { "200": { description: "budget, used, remaining" } } } },
    "/v1/plans": { get: { summary: "Card subscriptions for human operators (Stripe)", responses: { "200": { description: "plans[]" } } } },
    "/mcp": { post: { summary: "MCP streamable HTTP endpoint (22 tools incl. oracle_forecast, oracle_get, oracle_board, oracle_track_record)", responses: { "200": { description: "JSON-RPC / SSE" }, "402": { description: "payment required for priced tools after quota" } } } },
  },
});

export async function buildHttp() {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false, trustProxy: true });
  const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://intel.degenscan.io";

  // 1) Our access decision runs first (onRequest, before the x402 hook) and marks the request.
  //    POST /mcp is decided later, once the JSON-RPC body is parsed (see the /mcp handler).
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/mcp")) { (req.headers as any)["x-intel-access"] = "mcp"; return; }
    // Desk closed or full: let the request reach the handler (409, no payment asked) instead of quoting 450 USDC for something not on sale
    if (req.method === "POST" && req.url.startsWith("/v1/keys/x402/carry_desk_month")) { const st = deskSeats(); (req.headers as any)["x-intel-access"] = FREE_MODE || !st.open || st.available <= 0 ? "free" : "pay"; return; }
    if (req.method === "POST" && req.url.startsWith("/v1/keys/x402")) { (req.headers as any)["x-intel-access"] = FREE_MODE ? "free" : "pay"; return; }  // always paid, never quota/key
    const a = decideAccess(req);
    req.intelAccess = a ?? undefined;
    (req.headers as any)["x-intel-access"] = a ? a.method : "pay";
  });
  // 2) x402 v2 (+v1) payment middleware — 402s any REST route not marked as authorized.
  const x402 = await installX402(app);
  // 3) Billing log after the response.
  app.addHook("onResponse", async (req, reply) => {
    if (req.pendingKeyId) {
      // Prepaid key: activate only if the facilitator settled (PAYMENT-RESPONSE present and 2xx); otherwise drop it.
      let tx: string | null = null; let ok = reply.statusCode < 400;
      try { const h = reply.getHeader("payment-response"); if (h) { const r = JSON.parse(Buffer.from(String(h), "base64").toString("utf8")); tx = r?.transaction ?? null; ok = ok && r?.success !== false; } else if (!FREE_MODE) ok = false; } catch { ok = false; }
      if (ok) { activatePackKey(req.pendingKeyId, tx); const pack = req.purchasedPack ?? "pack_1k"; recordCall(pack === "carry_month" ? "carry_subscription" : (pack as string) === "carry_desk_month" ? "carry_desk_subscription" : "key_purchase", `x402:${(req.x402Context?.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, pack === "carry_month" ? CARRY.usd_month : (pack as string) === "carry_desk_month" ? CARRY_DESK.usd_month : (PACKS[pack as Pack]?.usd ?? 0), true, tx); }
      else dropPendingKey(req.pendingKeyId);
      return;
    }
    const tool = toolForRequest(req); if (!tool || reply.statusCode >= 400) return;
    if (req.x402Context) {
      let tx: string | null = null;
      try { const h = reply.getHeader("payment-response"); if (h) tx = JSON.parse(Buffer.from(String(h), "base64").toString("utf8"))?.transaction ?? null; } catch { /* ignore */ }
      recordCall(tool, `x402:${(req.x402Context.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, PRICES[tool] ?? 0.005, true, tx);
    }
    else if (req.intelAccess && req.intelAccess.method !== "free") recordCall(tool, req.intelAccess.payer, req.intelAccess.price, true);
  });
  const billing = (req: any, tool: string) => req.x402Context ? { tool, price_usd: PRICES[tool] ?? 0.005, method: "x402" } : { tool, price_usd: req.intelAccess?.price ?? 0, method: req.intelAccess?.method ?? "free" };

  app.get("/", async () => ({
    name: "degenscan-intel", version: "0.10.33",
    description: "No key required: market-event intelligence for trading agents — SEC filings, Fed/FOMC, regulators, disasters, Nasdaq halts, DeFi hacks, Polymarket odds, Hyperliquid funding/OI — scored per asset. 100 free calls/day, then USDC per call (x402, Base/Solana) or API key.",
    mcp: `${PUBLIC_URL}/mcp`, rest: `${PUBLIC_URL}/v1`, pricing: TOOL_DOCS, skill: `${PUBLIC_URL}/skill.md`, openapi: `${PUBLIC_URL}/openapi.json`, x402: `${PUBLIC_URL}/.well-known/x402`, plans: `${PUBLIC_URL}/v1/plans`, prepaid_keys: `${PUBLIC_URL}/v1/keys/packs`, metrics: `${PUBLIC_URL}/v1/metrics`, docs: `${PUBLIC_URL}/docs`, sdks: { js: "npm i @degenscan/intel", python: "pip install degenscan-intel" }, github: "https://github.com/tradewr333-lgtm/degenscan-intel", contact: "contact@degenscan.io",
    operator: OPERATOR, disclaimer: DISCLAIMER, license: "MIT",
  }));

  // Public usage metrics (free): one row per week since launch; owner/test wallets listed separately, never counted as customers.
  const metrics = () => ({ since: METRICS_SINCE, excluded_owner_wallets: EXCLUDED_WALLETS, note: "Paid calls = settled x402 payments (USDC on Base, tx hashes verifiable on basescan.org). Free calls = daily quota. Owner/test wallets are excluded from customers and revenue.", weeks: weeklyMetrics(METRICS_SINCE, EXCLUDED_WALLETS) });
  app.get("/v1/metrics", async () => metrics());
  app.get("/v1/metrics.csv", async (_r, reply) => {
    const m = metrics();
    const head = "week_start,week_end,calls_free,calls_api_key,calls_paid_x402,unique_paying_wallets,usdc_revenue,stripe_active_subscriptions,tx_hashes,excluded_owner_calls,excluded_owner_usdc,excluded_owner_tx_hashes";
    const lines = m.weeks.map(w => [w.week_start, w.week_end, w.calls_free, w.calls_api_key, w.calls_paid_x402, w.unique_paying_wallets, w.usdc_revenue, w.stripe_active_subscriptions, `"${w.tx_hashes.join(" ")}"`, w.excluded_owner_wallets.calls, w.excluded_owner_wallets.usdc, `"${w.excluded_owner_wallets.tx_hashes.join(" ")}"`].join(","));
    return reply.type("text/csv").header("content-disposition", "inline; filename=degenscan-intel-metrics.csv").send([head, ...lines].join("\n") + "\n");
  });
  // /health must stay O(1): Render kills the instance after a 5 s miss. Counts are cached and refreshed at most once a minute.
  let healthCounts = { events: 0, calls: 0, at: 0 };
  const refreshCounts = () => {
    try {
      healthCounts = { events: (getDb().prepare("SELECT MAX(rowid) AS n FROM events").get() as unknown as { n: number }).n ?? 0, calls: (getDb().prepare("SELECT MAX(rowid) AS n FROM calls").get() as unknown as { n: number }).n ?? 0, at: Date.now() };
    } catch { /* keep last */ }
  };
  app.get("/health", async () => {
    if (Date.now() - healthCounts.at > 60_000) refreshCounts();
    return { ok: true, events: healthCounts.events, calls: healthCounts.calls, connectors: CONNECTORS.length, storage: { path: DB_PATH, persistent: DB_PATH.startsWith("/data/") }, at: new Date().toISOString() };
  });
  // Agent skill (Claude/Cursor "skills" format): when to call which tool, loop, payment.
  const SKILL = (() => { try { return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../skills/degenscan-intel/SKILL.md"), "utf8"); } catch { return "# Degenscan Intel\nSee /llms.txt"; } })();
  app.get("/skill.md", async (_r, reply) => reply.type("text/markdown; charset=utf-8").send(SKILL));
  app.get("/.well-known/skills/degenscan-intel/SKILL.md", async (_r, reply) => reply.type("text/markdown; charset=utf-8").send(SKILL));
  // Machine-readable discovery for x402 indexers (Agent402, x402watch, x402scan) and generic agents.
  const PAY_TO = process.env.X402_PAY_TO ?? null;
  app.get("/.well-known/x402", async () => ({
    x402Version: 2, name: "Degenscan Intel", description: "Cross-asset market event intelligence for AI trading agents: ~40 primary sources scored into per-asset impacts.",
    operator: OPERATOR, url: PUBLIC_URL, network: "eip155:8453", asset: "USDC", payTo: PAY_TO,
    networks: [{ network: "eip155:8453", name: "Base", asset: "USDC", payTo: PAY_TO }, ...(PAY_TO_SOLANA ? [{ network: SOLANA_NETWORK, name: "Solana", asset: "USDC", payTo: PAY_TO_SOLANA }] : [])], facilitator: process.env.X402_FACILITATOR_URL ?? "https://facilitator.payai.network",
    resources: [
      ...TOOL_DOCS.filter(t => t.price_usd > 0 && t.tool !== "health").map(t => ({ tool: t.tool, price_usd: t.price_usd, http: REST_FOR[t.tool] ? `${t.tool === "oracle_forecast" ? "POST" : "GET"} ${PUBLIC_URL}${REST_FOR[t.tool]}` : undefined, mcp: `POST ${PUBLIC_URL}/mcp tools/call ${t.tool}` })),
      ...Object.entries(PACKS).map(([k, v]) => ({ tool: `prepaid_key:${k}`, price_usd: v.usd, http: `POST ${PUBLIC_URL}/v1/keys/x402/${k}`, calls: v.calls })),
    ],
    free: [`GET ${PUBLIC_URL}/v1/universe`, `GET ${PUBLIC_URL}/v1/sources`, `GET ${PUBLIC_URL}/v1/metrics`, `GET ${PUBLIC_URL}/health`, "MCP initialize/tools/list"],
    free_trial: { header: "X-Free-Trial: 1", calls_per_day_per_ip: 100, note: "Priced REST routes return 402 unless this header is sent or payment/X-API-KEY is provided. MCP tools/call gets the trial automatically." },
    docs: { llms: `${PUBLIC_URL}/llms.txt`, skill: `${PUBLIC_URL}/skill.md`, openapi: `${PUBLIC_URL}/openapi.json`, owned_wallets: `${PUBLIC_URL}/wallets.json`, metrics: `${PUBLIC_URL}/v1/metrics` },
  }));
  // A2A Agent Card (a2a-protocol.org): lets A2A registries (a2aregistry.org, a2a-registry.org) and agents discover what we offer.
  // We expose HTTP+JSON (REST) and MCP; payment is x402 on each call. No A2A JSON-RPC task endpoint is claimed.
  const AGENT_CARD = () => ({
    protocolVersion: "0.3.0", name: "Degenscan Intel", version: "0.10.33",
    description: "Market-event intelligence and calibrated probability forecasts for AI trading agents: ~40 primary sources (SEC, Fed, Polymarket, Hyperliquid, on-chain) scored into per-asset impacts; token contract risk verdicts; public Brier track record. Pay per call with x402 (USDC on Base or Solana) or an API key. Information and analytics only — not investment advice.",
    url: `${PUBLIC_URL}/a2a`, preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url: `${PUBLIC_URL}/a2a`, transport: "JSONRPC" }, { url: `${PUBLIC_URL}/v1`, transport: "HTTP+JSON" }],
    provider: { organization: OPERATOR, url: PUBLIC_URL },
    documentationUrl: `${PUBLIC_URL}/llms.txt`, iconUrl: `${PUBLIC_URL}/favicon.ico`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false,
      extensions: [
      { uri: "https://a2a-registry.org/extensions/registry/v1", description: "Registry metadata and payment capabilities", required: false,
        params: { payment: { model: "freemium", protocols: ["x402", "stripe"], direction: "inbound", rails: [
          { network: "base", token: "USDC", type: "stablecoin", protocol: "x402", scheme: "exact", caip2: "eip155:8453", contractAddress: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", settlementTime: "fast" },
          ...(PAY_TO_SOLANA ? [{ network: "solana", token: "USDC", type: "stablecoin", protocol: "x402", scheme: "exact", caip2: SOLANA_NETWORK, contractAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", settlementTime: "fast" }] : []),
          { network: "stripe", token: "USD", type: "fiat", protocol: "stripe" },
        ] } } },
      { uri: "https://x402.org", description: "x402 v2 pay-per-call (HTTP 402 → PAYMENT-SIGNATURE). Prices at /.well-known/x402", required: false, params: { networks: ["eip155:8453", ...(PAY_TO_SOLANA ? [SOLANA_NETWORK] : [])], asset: "USDC", pricing: `${PUBLIC_URL}/.well-known/x402` } }] },
    defaultInputModes: ["application/json"], defaultOutputModes: ["application/json"],
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-KEY" } },
    skills: TOOL_DOCS.filter(t => t.price_usd > 0 && t.tool !== "health").map(t => ({ id: t.tool, name: t.tool.replace(/_/g, " "), description: `${REST_FOR[t.tool] ? `${t.tool === "oracle_forecast" ? "POST" : "GET"} ${PUBLIC_URL}${REST_FOR[t.tool]}` : `MCP tools/call ${t.tool}`} — $${t.price_usd}/call (x402 USDC)`, tags: ["crypto", "markets", "trading", ...(t.tool.startsWith("oracle") ? ["forecast", "prediction"] : []), ...(t.tool === "token_verdict" ? ["security", "token-risk"] : [])], inputModes: ["application/json"], outputModes: ["application/json"] })),
  });
  // Minimal A2A JSON-RPC endpoint: message/send with a data part {skill, input} runs one tool through the same REST route
  // (same billing: X-API-KEY, x402 PAYMENT-SIGNATURE, or X-Free-Trial are forwarded). Stateless: every task completes in one call.
  const A2A_ROUTE: Record<string, (i: any) => { method: "GET" | "POST"; url: string; body?: any }> = {
    token_verdict: i => ({ method: "GET", url: `/v1/token/verdict/${encodeURIComponent(i.address ?? "")}?chain=${encodeURIComponent(i.chain ?? "base")}` }),
    price_for: i => ({ method: "GET", url: `/v1/price/${encodeURIComponent(i.symbol ?? "BTC")}` }),
    derivs_for: i => ({ method: "GET", url: `/v1/derivs/${encodeURIComponent(i.symbol ?? "BTC")}` }),
    funding_alerts: () => ({ method: "GET", url: "/v1/funding/alerts" }),
    whale_moves: i => ({ method: "GET", url: `/v1/whales${i.min_usd ? `?min_usd=${Number(i.min_usd)}` : ""}` }),
    polymarket_top: () => ({ method: "GET", url: "/v1/polymarket/top" }),
    polymarket_context: i => ({ method: "GET", url: `/v1/polymarket/${encodeURIComponent(i.market ?? "")}` }),
    pulse: () => ({ method: "GET", url: "/v1/pulse" }),
    events_since: i => ({ method: "GET", url: `/v1/events?since=${encodeURIComponent(i.since ?? "4h")}${i.universe ? `&universe=${encodeURIComponent([].concat(i.universe).join(","))}` : ""}` }),
    impact_for: i => ({ method: "GET", url: `/v1/impact/${encodeURIComponent(i.asset_id ?? i.symbol ?? "BTC")}?since=${encodeURIComponent(i.since ?? "24h")}` }),
    exposure_graph: i => ({ method: "GET", url: `/v1/graph/${encodeURIComponent(i.asset_id ?? "NVDA")}` }),
    regime_snapshot: () => ({ method: "GET", url: "/v1/regime" }),
    explain: i => ({ method: "GET", url: `/v1/explain/${encodeURIComponent(i.event_id ?? "")}` }),
    news_for: i => ({ method: "GET", url: `/v1/news/${encodeURIComponent(i.ticker ?? i.symbol ?? "BTC")}` }),
    filings_for: i => ({ method: "GET", url: `/v1/filings/${encodeURIComponent(i.ticker ?? "NVDA")}` }),
    calendar: i => ({ method: "GET", url: `/v1/calendar?days=${Number(i.days ?? 7)}` }),
    brief: i => ({ method: "GET", url: `/v1/brief/${encodeURIComponent(i.asset_id ?? i.symbol ?? "BTC")}` }),
    oracle_board: () => ({ method: "GET", url: "/v1/oracle/board" }),
    polymarket_edge: i => ({ method: "GET", url: `/v1/oracle/edge?min_abs=${Number(i.min_abs ?? 0)}&limit=${Number(i.limit ?? 20)}` }),
    oracle_forecast: i => ({ method: "POST", url: "/v1/oracle/forecast", body: i }),
    oracle_track_record: () => ({ method: "GET", url: "/v1/oracle/track-record" }),
  };
  app.post("/a2a", async (req: any, reply) => {
    const rpc = req.body ?? {}; const id = rpc.id ?? null;
    const err = (code: number, message: string, data?: any) => ({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
    if (rpc.method === "agent/getCard" || rpc.method === "agent/getAuthenticatedExtendedCard") return { jsonrpc: "2.0", id, result: AGENT_CARD() };
    if (rpc.method !== "message/send") return err(-32601, `method ${rpc.method} not supported; use message/send`);
    const msg = rpc.params?.message ?? {}; const parts: any[] = msg.parts ?? [];
    const data = parts.find(p => p.kind === "data" || p.type === "data")?.data ?? null;
    const text = parts.filter(p => p.kind === "text" || p.type === "text").map(p => p.text).join(" ").trim();
    const skill = data?.skill ?? (text && A2A_ROUTE[text.split(/\s+/)[0]] ? text.split(/\s+/)[0] : null);
    const ctx = msg.contextId ?? randomBytes(8).toString("hex"); const taskId = randomBytes(8).toString("hex");
    const agentMsg = (partsOut: any[]) => ({ kind: "message", role: "agent", messageId: randomBytes(8).toString("hex"), contextId: ctx, taskId, parts: partsOut });
    if (!skill || !A2A_ROUTE[skill]) {
      return { jsonrpc: "2.0", id, result: { kind: "task", id: taskId, contextId: ctx, status: { state: "input-required", timestamp: new Date().toISOString(), message: agentMsg([{ kind: "text", text: `Send a data part {"skill": "<id>", "input": {...}}. Skills: ${Object.keys(A2A_ROUTE).join(", ")}. Example: {"skill":"token_verdict","input":{"address":"0x…","chain":"base"}}. Prices: ${PUBLIC_URL}/.well-known/x402` }]) } } };
    }
    const r = A2A_ROUTE[skill](data?.input ?? {});
    const fwd: Record<string, string> = {};
    for (const h of ["x-api-key", "payment-signature", "x-payment", "x-free-trial"]) if (req.headers[h]) fwd[h] = String(req.headers[h]);
    const res = await app.inject({ method: r.method, url: r.url, headers: { ...fwd, ...(r.body ? { "content-type": "application/json" } : {}) }, payload: r.body ? JSON.stringify(r.body) : undefined });
    let out: any; try { out = res.json(); } catch { out = { raw: res.body }; }
    if (res.statusCode === 402) { reply.header("payment-required", String(res.headers["payment-required"] ?? "")); return err(402, "payment required: resend with PAYMENT-SIGNATURE (x402 v2), X-API-KEY, or X-Free-Trial: 1", { payment_required: res.headers["payment-required"] ?? null, accepts: out?.accepts ?? null, pricing: `${PUBLIC_URL}/.well-known/x402` }); }
    if (res.headers["payment-response"]) reply.header("payment-response", String(res.headers["payment-response"]));
    const state = res.statusCode < 400 ? "completed" : "failed";
    return { jsonrpc: "2.0", id, result: { kind: "task", id: taskId, contextId: ctx, status: { state, timestamp: new Date().toISOString() }, artifacts: [{ artifactId: randomBytes(6).toString("hex"), name: skill, parts: [{ kind: "data", data: out }] }], history: [msg, agentMsg([{ kind: "text", text: state === "completed" ? `${skill} done (HTTP ${res.statusCode})` : `${skill} failed (HTTP ${res.statusCode}): ${out?.error ?? ""}` }])] } };
  });
  app.get("/.well-known/agent-card.json", async () => AGENT_CARD());
  app.get("/.well-known/agent.json", async () => AGENT_CARD());
  // Owner/test wallets, published so explorers and buyers can verify our usage metrics exclude self-payments.
  app.get("/wallets.json", async () => ({ operator: OPERATOR, pay_to: PAY_TO, pay_to_solana: PAY_TO_SOLANA, owned_or_test_wallets: EXCLUDED_WALLETS, note: "Payments from these addresses are the operator's own tests; they are excluded from customers and revenue in /v1/metrics." }));
  app.get("/openapi.json", async () => OPENAPI(PUBLIC_URL));
  app.get("/favicon.ico", async (_r, reply) => reply.type("image/png").header("cache-control", "public, max-age=86400").send(Buffer.from(ICON_PNG_B64, "base64")));
  app.get("/icon.png", async (_r, reply) => reply.type("image/png").send(Buffer.from(ICON_PNG_B64, "base64")));
  // Glama ownership challenge (https://glama.ai) — token is account-bound, contains no secrets; overridable via env.
  app.get("/.well-known/glama.json", async () => ({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: process.env.GLAMA_CLAIM ?? "glama_claim__jjuT9diA1oBYRDhpNvBl7A9aD4RRMbR" }));
  installDocs(app, PUBLIC_URL);
  installOracleRoutes(app, billing);
  installAppRoutes(app);
  // Carry Oracle (Renato 04/10 — non-negotiable): flat toll of US$100/month, card (Stripe) or USDC (x402). No per-request metering:
  // a live carry key gets everything in real time; without one, only /v1/carry/stats (dataset size) and the /carry page are open.
  const CARRY_DISCLAIMER = "Market data and analytics only — not a signal, not investment advice. Informação e análise, não é recomendação de investimento.";
  const carryPaywall = (reply: any, reason?: string) => reply.code(402).send({
    error: "carry_subscription_required", reason: reason ?? "no key",
    product: "Carry Oracle — Hyperliquid funding on every dex (main + HIP-3), cross-dex spreads, spot/perp, hourly history kept without a window",
    price: `US$${CARRY.usd_month}/month, flat — unlimited calls`,
    pay_card: `${PUBLIC_URL}/v1/carry/checkout`, pay_usdc: `POST ${PUBLIC_URL}/v1/keys/x402/carry_month (x402, ${CARRY.usd_month} USDC on Base = ${CARRY.days_per_usdc_payment} days)`,
    then: "send header X-API-KEY: <your dsi_carry_ key>", info: `${PUBLIC_URL}/carry`, disclaimer: CARRY_DISCLAIMER });
  // In FREE_MODE (tests / no x402 configured) the payment middleware is off, so the subscription is checked here; in production the
  // access hook + x402 middleware already enforced it (subscription key, prepaid pack credits, or a settled per-call payment).
  const carryOk = (req: any, reply: any): boolean => FREE_MODE ? carryGate(req, reply) : true;
  const carryGate = (req: any, reply: any): boolean => {
    if (process.env.ORACLE_OPERATOR_KEY && req.headers["x-operator-key"] === process.env.ORACLE_OPERATOR_KEY) return true;
    const a = carryAccess(req.headers["x-api-key"] as string | undefined);
    if (a.ok) return true;
    carryPaywall(reply, a.reason); return false;
  };
  app.get("/carry", async (req: any, reply: any) => { const { carryPage } = await import("./carry-page.js"); return reply.type("text/html; charset=utf-8").send(carryPage(req.query?.lang === "en" ? "en" : "pt")); });
  app.get("/v1/carry/stats", async () => ({ ...carryStats(), tiers: [{ name: "Carry Data", price: `US$${CARRY.usd_month}/month flat, unlimited calls`, pay_card: `${PUBLIC_URL}/v1/carry/checkout`, pay_usdc: `POST ${PUBLIC_URL}/v1/keys/x402/carry_month`, routes: ["funding-matrix", "xdex", "spot-perp", "history/{coin}", "naked", "watchdog"].map(r => `/v1/carry/${r}`) }, (() => { const st = deskSeats(); return { name: "Carry Desk", price: `US$${CARRY_DESK.usd_month}/month or US$${CARRY_DESK.usd_year}/year`, seats: st, status: st.open ? (st.available > 0 ? "open" : "full — waitlist") : "opening soon — waitlist", pay_card: `${PUBLIC_URL}/v1/carry/desk/checkout`, pay_usdc: `POST ${PUBLIC_URL}/v1/keys/x402/carry_desk_month`, routes: ["eligible", "capacity", "realized", "realized/{pair}", "afterhours", "afterhours/{coin}", "alerts"].map(r => `/v1/carry/${r}`), waitlist: `POST ${PUBLIC_URL}/v1/carry/waitlist` }; })()], docs: `${PUBLIC_URL}/docs/carry`, info: `${PUBLIC_URL}/carry`, disclaimer: CARRY_DISCLAIMER }));
  app.get("/v1/carry/funding-matrix", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...fundingMatrix({ dex: req.query?.dex ? String(req.query.dex) : undefined, minVol: Number(req.query?.min_vol ?? 0) || 0 }), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/xdex", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...crossDex({ minVol: Number(req.query?.min_vol ?? 100_000) || 0, limit: Math.min(200, Number(req.query?.limit ?? 50) || 50) }), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/spot-perp", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...spotPerp({ minVol: Number(req.query?.min_vol ?? 100_000) || 0, limit: Math.min(200, Number(req.query?.limit ?? 50) || 50) }), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/naked", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...naked({ minAbsApr: Number(req.query?.min_abs_apr ?? 0.5) || 0.5, minVol: Number(req.query?.min_vol ?? 0) || 0, limit: Math.min(300, Number(req.query?.limit ?? 100) || 100) }), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/watchdog", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...watchdog(), disclaimer: CARRY_DISCLAIMER }; });
  // Carry Desk waitlist: public, no payment, no cookie; 5/h per IP; honeypot field "website".
  const wlHits = new Map<string, { h: number; n: number }>();
  app.post("/v1/carry/waitlist", async (req: any, reply: any) => {
    const b = (req.body ?? {}) as any;
    if (b.website) return reply.code(201).send({ ok: true });
    const h = Math.floor(Date.now() / 3_600_000); const c = wlHits.get(req.ip);
    if (c && c.h === h && c.n >= 5) return reply.code(429).send({ error: "too many requests" });
    wlHits.set(req.ip, c && c.h === h ? { h, n: c.n + 1 } : { h, n: 1 });
    const email = String(b.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i.test(email)) return reply.code(400).send({ error: "valid email required" });
    const pick = (v: unknown, ok: string[]) => ok.includes(String(v)) ? String(v) : null;
    ensureWaitlist();
    getDb().prepare(`INSERT INTO carry_waitlist (created_at, email, name, profile, capital_range, venues, tier_interest, lang, source, ip_hash) VALUES (?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name = excluded.name, profile = excluded.profile, capital_range = excluded.capital_range, venues = excluded.venues, tier_interest = excluded.tier_interest`)
      .run(new Date().toISOString(), email, String(b.name ?? "").slice(0, 120) || null, pick(b.profile, ["vault", "fund", "dev", "agent", "data_provider", "other"]),
        pick(b.capital_range, ["<10k", "10k-100k", "100k-1M", ">1M", "n/a"]), String(b.venues ?? "").slice(0, 300) || null, pick(b.tier_interest, ["data", "desk", "enterprise"]),
        pick(b.lang, ["pt", "en"]), String(b.source ?? "carry_page").slice(0, 60), _ch("sha256").update(String(req.ip)).digest("hex").slice(0, 16));
    return reply.code(201).send({ ok: true });
  });
  app.get("/v1/admin/carry/waitlist", async (req: any, reply: any) => {
    if (!process.env.ORACLE_OPERATOR_KEY || req.headers["x-operator-key"] !== process.env.ORACLE_OPERATOR_KEY) return reply.code(401).send({ error: "operator key required" });
    ensureWaitlist(); const rows = getDb().prepare("SELECT created_at, email, name, profile, capital_range, venues, tier_interest, lang, source FROM carry_waitlist ORDER BY id").all() as any[];
    if (String(req.query?.format) === "csv") { const cols = ["created_at", "email", "name", "profile", "capital_range", "venues", "tier_interest", "lang", "source"]; return reply.type("text/csv").send([cols.join(","), ...rows.map(r => cols.map(c => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n") + "\n"); }
    return { count: rows.length, items: rows };
  });
  // ---- Carry Desk (Lote B): subscription-only routes (US$450/month · 4,500/year · limited seats). Data keys get a 403 with the upgrade path.
  const deskGate = (req: any, reply: any): string | null => {
    if (process.env.ORACLE_OPERATOR_KEY && req.headers["x-operator-key"] === process.env.ORACLE_OPERATOR_KEY) return "operator";
    const a = deskAccess(req.headers["x-api-key"] as string | undefined);
    if (a.ok) return a.id!;
    const seats = deskSeats();
    reply.code(String(a.reason ?? "").includes("Carry Data") ? 403 : 402).send({ error: "carry_desk_subscription_required", reason: a.reason ?? "no key",
      product: "Carry Desk — eligibility filters, per-pair capacity, net realized carry, after-hours premium, webhook alerts (plus everything in Carry Data)",
      price: `US$${CARRY_DESK.usd_month}/month or US$${CARRY_DESK.usd_year}/year`, seats: { available: seats.available, total: seats.total, open: seats.open },
      pay_card: `${PUBLIC_URL}/v1/carry/desk/checkout`, pay_usdc: `POST ${PUBLIC_URL}/v1/keys/x402/carry_desk_month (${CARRY_DESK.usd_month} USDC = ${CARRY_DESK.days_per_usdc_payment} days)`,
      waitlist: `POST ${PUBLIC_URL}/v1/carry/waitlist`, info: `${PUBLIC_URL}/carry`, disclaimer: CARRY_DISCLAIMER });
    return null;
  };
  const qn = (v: unknown) => v == null || v === "" ? undefined : Number(v);
  app.get("/v1/carry/eligible", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { eligible } = await import("../carry/desk.js");
    return { ...(await eligible({ entry_apr: qn(req.query?.entry_apr), min_share: qn(req.query?.min_share), min_corr: qn(req.query?.min_corr), max_basis_range: qn(req.query?.max_basis_range), min_liq: qn(req.query?.min_liq), max_breakeven_days: qn(req.query?.max_breakeven_days), fee_bps: qn(req.query?.fee_bps) } as any, { minVol: qn(req.query?.min_vol), onlyEligible: req.query?.only === "eligible" })), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/capacity", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { capacity } = await import("../carry/desk.js");
    return { ...(await capacity({ capital: qn(req.query?.capital), lev: qn(req.query?.lev), maxPairs: qn(req.query?.max_pairs) })), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/realized", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { realizedAll } = await import("../carry/desk.js"); return { ...(await realizedAll()), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/realized/:pair", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { realized } = await import("../carry/desk.js");
    try { return { ...(await realized(decodeURIComponent(String(req.params.pair)), { feeBps: qn(req.query?.fee_bps) })), disclaimer: CARRY_DISCLAIMER }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); } });
  app.get("/v1/carry/afterhours", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { afterhours } = await import("../carry/desk.js"); return { ...(await afterhours()), disclaimer: CARRY_DISCLAIMER }; });
  app.get("/v1/carry/afterhours/:coin", async (req: any, reply: any) => { if (!deskGate(req, reply)) return reply; const { afterhours } = await import("../carry/desk.js"); return { ...(await afterhours(decodeURIComponent(String(req.params.coin)))), disclaimer: CARRY_DISCLAIMER }; });
  app.post("/v1/carry/alerts", async (req: any, reply: any) => { const id = deskGate(req, reply); if (!id) return reply; const { createAlert } = await import("../carry/desk.js");
    try { return reply.code(201).send(createAlert(id, req.body ?? {})); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); } });
  app.get("/v1/carry/alerts", async (req: any, reply: any) => { const id = deskGate(req, reply); if (!id) return reply; const { listAlerts } = await import("../carry/desk.js"); return { items: listAlerts(id) }; });
  app.delete("/v1/carry/alerts/:id", async (req: any, reply: any) => { const id = deskGate(req, reply); if (!id) return reply; const { deleteAlert } = await import("../carry/desk.js"); return { deleted: deleteAlert(id, String(req.params.id)) }; });
  // Operator: open/close the Desk and set seats (no deploy).
  app.post("/v1/admin/carry/desk", async (req: any, reply: any) => {
    if (!process.env.ORACLE_OPERATOR_KEY || req.headers["x-operator-key"] !== process.env.ORACLE_OPERATOR_KEY) return reply.code(401).send({ error: "operator key required" });
    const b = req.body ?? {}; if (b.open != null) setCarrySetting("desk_open", b.open ? "1" : "0"); if (b.seats != null && Number(b.seats) >= 0) setCarrySetting("desk_seats", String(Math.floor(Number(b.seats))));
    return deskSeats();
  });
  app.get("/docs/carry", async (req: any, reply: any) => { const { carryDocsPage } = await import("./carry-page.js"); return reply.type("text/html; charset=utf-8").send(carryDocsPage()); });
  app.get("/v1/carry/history/:coin", async (req: any, reply: any) => { if (!carryOk(req, reply)) return reply; return { ...coinHistory(decodeURIComponent(String(req.params.coin)), Number(req.query?.hours ?? 720) || 720), disclaimer: CARRY_DISCLAIMER }; });
  installHelpRoutes(app);
  app.get("/llms.txt", async (_r, reply) => reply.type("text/plain").send(
    `# Degenscan Intel\n> Cross-asset event intelligence for trading agents: SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket and 30+ more primary sources normalized into one event schema and scored against an exposure graph into per-asset impacts.\n\n## Carry Oracle — Hyperliquid funding on every dex (subscription)\n- Hourly funding for every perp on every Hyperliquid dex (main + HIP-3: xyz, io, para, mkts…), kept beyond the 500 h the Hyperliquid API returns; cross-dex same-ticker spreads; spot×perp basis; funding extremes with no hedge; market health.\n- Routes (header X-API-KEY: dsi_carry_…): GET ${PUBLIC_URL}/v1/carry/funding-matrix · /v1/carry/xdex · /v1/carry/spot-perp · /v1/carry/history/{coin} (HIP-3 coins prefixed, e.g. xyz:NBIS) · /v1/carry/naked · /v1/carry/watchdog. Free: /v1/carry/stats.\n- Price: US$100/month flat, unlimited calls, no per-request metering. Card: ${PUBLIC_URL}/v1/carry/checkout · USDC (x402, Base or Solana): POST ${PUBLIC_URL}/v1/keys/x402/carry_month = 30 days. Without a carry key the routes answer 402 with how to pay.\n- MCP tools: carry_funding_matrix, carry_xdex, carry_spot_perp, carry_history, carry_naked, carry_watchdog (send X-API-KEY on the MCP request).\n- Docs with real sample responses and field dictionary: ${PUBLIC_URL}/docs/carry. Market data and analytics only — not a signal, not investment advice.\n\n## Endpoints\n- MCP (streamable HTTP): POST ${PUBLIC_URL}/mcp\n- REST: ${PUBLIC_URL}/v1/pulse ($0.001 probe) · /v1/events?since=4h&universe=NVDA,BTC · /v1/impact/{asset} · /v1/graph/{asset} · /v1/regime · /v1/explain/{event_id} · /v1/polymarket/{market}?since=48h · /v1/news/{ticker} · /v1/price/{symbol} ($0.001, no key) · /v1/funding/alerts ($0.001) · /v1/whales ($0.002) · /v1/polymarket/top ($0.002) · /v1/derivs/{symbol} (perp funding/OI, Hyperliquid) · /v1/filings/{ticker} · /v1/calendar?days=7 · /v1/brief/{asset} ($0.10 premium, replaces 6 calls) · /v1/token/verdict/{address}?chain=base ($0.01: token contract risk verdict — honeypot, taxes, mint/pause/blacklist, owner, holders, LP lock, liquidity; EVM + Solana) · POST /v1/oracle/forecast ($0.25, async: calibrated probability for a binary question, Monte Carlo agent societies + expert panel, public Brier record) · /v1/oracle/board ($0.002, daily standing forecasts) · /v1/oracle/edge ($0.002: Polymarket markets where the oracle disagrees most, sorted by |p − odds|) · /oracle (human scorecard page) · /v1/oracle/track-record (free) · /v1/universe (free) · /v1/sources (free)\n\n## Pricing\n${TOOL_DOCS.map(t => `- ${t.tool}: $${t.price_usd} per call`).join("\n")}\n- Free trial: send header  X-Free-Trial: 1  for 100 free calls/day per IP on REST (MCP tools/call gets it automatically). Without it, priced routes answer HTTP 402 with x402 v2 payment requirements (USDC on Base, eip155:8453). Or buy a prepaid key with USDC, no human needed: POST ${PUBLIC_URL}/v1/keys/x402/pack_1k → $5 for 1,000 calls (pack_10k $40, pack_100k $300), lifetime budget, check balance at /v1/keys/me. Or subscribe with a card: ${PUBLIC_URL}/v1/plans. Both give an X-API-KEY header.\n\n## SDKs\n- JavaScript/TypeScript: npm i @degenscan/intel  →  new Intel({ privateKey | apiKey }).eventsSince({ since: "4h", universe: ["NVDA","BTC"] })\n- Python: pip install degenscan-intel  →  Intel(private_key=... | api_key=...).events_since(since="4h", universe=["NVDA","BTC"])\nBoth pay the 402 automatically (USDC on Base) or send X-API-KEY.\n\n## Docs (one page per question, with curl/JS/Python)\n${PUBLIC_URL}/docs · full text: ${PUBLIC_URL}/llms-full.txt\n\n## Agent skill\n${PUBLIC_URL}/skill.md — when to call which tool, recommended loop, how to pay.\n\n## Operator\n${OPERATOR}. Public usage metrics: ${PUBLIC_URL}/v1/metrics (JSON) · ${PUBLIC_URL}/v1/metrics.csv\n\n## Disclaimer\n${DISCLAIMER}\n\n## Schema\nEvent { id, ts_event, kind, title, summary, entities[], severity, novelty, impacts[{asset_id, direction:-1|0|1, confidence, horizon, path[], rationale}], tradable_now[], next_open[], source{tier}, corroboration }\n`));

  // ---- REST
  const coerce = (q: any) => ({ ...q, universe: typeof q.universe === "string" ? q.universe.split(",") : q.universe, kinds: typeof q.kinds === "string" ? q.kinds.split(",") : q.kinds,
    min_severity: q.min_severity != null ? Number(q.min_severity) : undefined, min_confidence: q.min_confidence != null ? Number(q.min_confidence) : undefined, limit: q.limit != null ? Number(q.limit) : undefined, depth: q.depth != null ? Number(q.depth) : undefined });
  const wrap = (tool: string, fn: (req: any) => unknown) => async (req: any, reply: any) => {
    try { return { ...(fn(req) as any), _billing: billing(req, tool) }; } catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  app.get("/v1/events", wrap("events_since", req => eventsSince(EventsSinceArgs.parse(coerce(req.query)))));
  app.post("/v1/events", wrap("events_since", req => eventsSince(EventsSinceArgs.parse(coerce({ ...req.query, ...(req.body ?? {}) })))));
  app.get("/v1/impact/:asset_id", wrap("impact_for", req => impactFor(ImpactForArgs.parse({ ...coerce(req.query), asset_id: req.params.asset_id }))));
  app.get("/v1/graph/:asset_id", wrap("exposure_graph", req => exposureGraph(ExposureGraphArgs.parse({ ...coerce(req.query), asset_id: req.params.asset_id }))));
  app.get("/v1/regime", wrap("regime_snapshot", () => regimeSnapshot()));
  app.get("/v1/explain/:event_id", wrap("explain", req => explain(req.params.event_id)));
  app.get("/v1/pulse", wrap("pulse", () => pulse()));
  app.get("/v1/news/:ticker", wrap("news_for", req => newsFor(NewsArgs.parse({ ...coerce(req.query), ticker: req.params.ticker }))));
  app.get("/v1/derivs/:symbol", async (req: any, reply: any) => {
    try { return { ...(await derivsFor(DerivsArgs.parse({ ...coerce(req.query), symbol: req.params.symbol }))), _billing: billing(req, "derivs_for") }; }
    catch (e: any) { reply.code(/unknown perp/.test(String(e?.message)) ? 404 : 502); return { error: String(e?.message ?? e) }; }
  });
  app.get("/v1/filings/:ticker", wrap("filings_for", req => filingsFor(FilingsArgs.parse({ ...coerce(req.query), forms: typeof req.query.forms === "string" ? req.query.forms.split(",") : req.query.forms, ticker: req.params.ticker }))));
  app.get("/v1/calendar", wrap("calendar", req => calendar(CalendarArgs.parse({ ...coerce(req.query), days: req.query.days != null ? Number(req.query.days) : undefined, types: typeof req.query.types === "string" ? req.query.types.split(",") : req.query.types }))));
  app.get("/v1/brief/:asset_id", async (req: any, reply: any) => {
    try { return { ...(await brief(BriefArgs.parse({ ...coerce(req.query), asset_id: req.params.asset_id }))), _billing: billing(req, "brief") }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.get("/v1/polymarket/top", async (req: any, reply: any) => {
    try { return { ...(await polymarketTop(PolyTopArgs.parse({ ...coerce(req.query), limit: req.query.limit != null ? Number(req.query.limit) : undefined }))), _billing: billing(req, "polymarket_top") }; }
    catch (e: any) { reply.code(502); return { error: String(e?.message ?? e) }; }
  });
  app.get("/v1/price/:symbol", async (req: any, reply: any) => {
    try { return { ...(await priceFor(PriceArgs.parse({ symbol: req.params.symbol }))), _billing: billing(req, "price_for") }; }
    catch (e: any) { reply.code(/unknown symbol/.test(String(e?.message)) ? 404 : 502); return { error: String(e?.message ?? e) }; }
  });
  app.get("/v1/token/verdict/:address", async (req: any, reply: any) => {
    try { return { ...(await tokenVerdict(TokenVerdictArgs.parse({ address: req.params.address, chain: typeof req.query.chain === "string" ? req.query.chain : undefined }))), _billing: billing(req, "token_verdict") }; }
    catch (e: any) { const m = String(e?.message ?? e); reply.code(/invalid address|unsupported chain|base58 address/.test(m) ? 400 : /not found/.test(m) ? 404 : 502); return { error: m }; }
  });
  app.get("/v1/funding/alerts", async (req: any, reply: any) => {
    try { return { ...(await fundingAlerts(FundingAlertsArgs.parse({ min_abs_rate_1h: req.query.min_abs_rate_1h != null ? Number(req.query.min_abs_rate_1h) : undefined, limit: req.query.limit != null ? Number(req.query.limit) : undefined }))), _billing: billing(req, "funding_alerts") }; }
    catch (e: any) { reply.code(502); return { error: String(e?.message ?? e) }; }
  });
  app.get("/v1/whales", async (req: any, reply: any) => {
    try { return { ...(await whaleMoves(WhaleArgs.parse({ min_usd: req.query.min_usd != null ? Number(req.query.min_usd) : undefined, chains: typeof req.query.chains === "string" ? req.query.chains.split(",") : req.query.chains, limit: req.query.limit != null ? Number(req.query.limit) : undefined }))), _billing: billing(req, "whale_moves") }; }
    catch (e: any) { reply.code(502); return { error: String(e?.message ?? e) }; }
  });
  app.get("/v1/polymarket/:market", async (req: any, reply: any) => {
    try { return { ...(await polymarketContext(PolymarketContextArgs.parse({ ...coerce(req.query), market: decodeURIComponent(req.params.market) }))), _billing: billing(req, "polymarket_context") }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  });
  app.get("/v1/universe", async () => universe());
  app.get("/v1/sources", async () => sources());

  // ---- Prepaid API keys for autonomous agents (x402, USDC). The payment middleware has already verified the payment
  //      when this handler runs; the key is returned now and activated in onResponse once settlement succeeds.
  const buyPack = (pack: Pack) => async (req: any, reply: any) => {
    if (FREE_MODE) return reply.code(503).send({ error: "x402 not configured on this deployment", packs: PACKS });
    const wallet = (req.x402Context?.paymentPayload as any)?.payload?.authorization?.from ?? null;
    const { id, key } = createPackKey(pack, wallet);
    req.pendingKeyId = id; req.purchasedPack = pack;
    return { api_key: key, key_id: id, pack, calls: PACKS[pack].calls, paid_usd: PACKS[pack].usd, payer: wallet,
      usage: "send header  X-API-KEY: <api_key>  on /v1/* or POST /mcp", check: `${PUBLIC_URL}/v1/keys/me`, note: "Shown once. Store it now. Budget is lifetime (no expiry)." };
  };
  for (const pack of Object.keys(PACKS) as Pack[]) app.post(`/v1/keys/x402/${pack}`, buyPack(pack));
  app.post("/v1/keys/x402/carry_month", async (req: any, reply: any) => {
    if (FREE_MODE) return reply.code(503).send({ error: "x402 not configured on this deployment" });
    const wallet = (req.x402Context?.paymentPayload as any)?.payload?.authorization?.from ?? null;
    const { id, key } = createCarryKey({ via: "x402", wallet });
    req.pendingKeyId = id; req.purchasedPack = "carry_month";
    return { api_key: key, key_id: id, product: "carry_month", paid_usd: CARRY.usd_month, days: CARRY.days_per_usdc_payment, payer: wallet,
      usage: "send header  X-API-KEY: <api_key>  on /v1/carry/*", check: `${PUBLIC_URL}/v1/keys/me`, note: "Shown once. Store it now. Pay again before it expires for another 30 days (a new key is issued)." };
  });
  app.post("/v1/keys/x402/carry_desk_month", async (req: any, reply: any) => {
    if (FREE_MODE) return reply.code(503).send({ error: "x402 not configured on this deployment" });
    const seats = deskSeats();
    // refusing here (4xx) means the facilitator never settles: no charge when the Desk is closed or full
    if (!seats.open || seats.available <= 0) return reply.code(409).send({ error: seats.open ? "carry_desk_full" : "carry_desk_not_open", seats, waitlist: `POST ${PUBLIC_URL}/v1/carry/waitlist`, note: "No payment was taken." });
    const wallet = (req.x402Context?.paymentPayload as any)?.payload?.authorization?.from ?? null;
    const { id, key } = createCarryKey({ via: "x402", tier: "desk", wallet });
    req.pendingKeyId = id; req.purchasedPack = "carry_desk_month" as any;
    return { api_key: key, key_id: id, product: "carry_desk_month", paid_usd: CARRY_DESK.usd_month, days: CARRY_DESK.days_per_usdc_payment, payer: wallet,
      usage: "send header  X-API-KEY: <api_key>  on /v1/carry/*", check: `${PUBLIC_URL}/v1/keys/me`, note: "Shown once. Store it now." };
  });
  app.post("/v1/keys/x402", async (_r, reply) => reply.code(400).send({ error: "choose a pack in the URL", endpoints: Object.keys(PACKS).map(p => `POST ${PUBLIC_URL}/v1/keys/x402/${p}`), packs: PACKS }));
  app.get("/v1/keys/packs", async () => ({ how: `POST ${PUBLIC_URL}/v1/keys/x402/<pack> (empty body); answer the 402 with an x402 payment (USDC on Base). No account, no card, no human.`, endpoints: Object.keys(PACKS).map(p => `POST ${PUBLIC_URL}/v1/keys/x402/${p}`), packs: PACKS, network: "eip155:8453 (Base)", asset: "USDC" }));
  app.get("/v1/keys/me", async (req: any, reply) => {
    const raw = (req.headers["x-api-key"] as string | undefined)?.trim();
    if (!raw) return reply.code(400).send({ error: "send X-API-KEY header" });
    const st = keyStatus(raw); if (!st) return reply.code(404).send({ error: "unknown key" });
    return st;
  });

  installStripe(app);

  // ---- MCP (stateless streamable HTTP). The body is only known here, so payment is processed manually:
  //      free handshake/tools/list, free tools, API keys and the daily quota pass; otherwise x402 verify → run → settle.
  app.post("/mcp", async (req: any, reply) => {
    const access = decideAccess(req);
    req.intelAccess = access ?? undefined;
    let verified: Extract<Awaited<ReturnType<typeof x402.processHTTPRequest>>, { type: "payment-verified" }> | undefined;
    if (!access) {
      (req.headers as any)["x-intel-access"] = "pay";   // the protected-request hook must not grant this one
      const context = { adapter: new FastifyAdapter(req), path: "/mcp", method: "POST", paymentHeader: req.headers["payment-signature"] || req.headers["x-payment"] };
      const result = await x402.processHTTPRequest(context);
      if (result.type === "payment-error") {
        for (const [k, v] of Object.entries(result.response.headers)) reply.header(k, v);
        return reply.code(result.response.status).send(result.response.body ?? {});
      }
      if (result.type === "payment-verified") verified = result;
    }
    const server = buildMcpServer({ carryKey: req.headers["x-api-key"] as string | undefined, operator: Boolean(process.env.ORACLE_OPERATOR_KEY && req.headers["x-operator-key"] === process.env.ORACLE_OPERATOR_KEY), carryPaid: !FREE_MODE && (Boolean(verified) || access?.method === "api_key") });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    reply.hijack();
    if (verified) {
      // Settle right after the response is flushed (authorization flow); receipt is logged, not returned (stream already closed).
      const v = verified; let done = false;
      reply.raw.on("finish", () => {
        if (done) return; done = true;
        x402.processSettlement(v.paymentPayload, v.paymentRequirements, v.declaredExtensions, undefined, undefined, v.beforeHandlerSettlement)
          .then(s => { const tool = toolForRequest(req) ?? "mcp"; recordCall(tool, `x402:${(v.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, PRICES[tool] ?? 0.005, s.success, s.success ? (s as any).transaction ?? null : null); if (!s.success) console.warn("[x402/mcp] settle failed:", s.errorReason); })
          .catch(e => console.warn("[x402/mcp] settle error:", (e as Error).message));
      });
    }
    await transport.handleRequest(req.raw, reply.raw, req.body);
    reply.raw.on("close", () => { transport.close(); server.close(); });
  });
  app.get("/mcp", async (_r, reply) => reply.code(405).send({ error: "stateless server: use POST" }));
  app.delete("/mcp", async (_r, reply) => reply.code(405).send({ error: "stateless server" }));

  return app;
}

// 64×64 flat icon (dark square, green dot) so registries have something to show.
const ICON_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAqklEQVR4nO3aMQ6AIAwF0F7A+x/GxdXFxcXEE7g4uLg4mHgAB0MICVZaWvpe0kADv18KFTjnnHPOOeecc86ZWkRk1lo7q7X21lq7EJEBgAGAdT0/ZWYAAJdSyi3G+MjMrJlZa63Vu+3PzgDgKKX0sXx2rr8xM/M8z/cQwiPn/A6ARURuAEBpYTZmZgCwl1LWGON5Bcy9tf8gEpH/uee/Tyfy5WdmZgAwAPhZ1QB4Ob4z9/xzzjnnnHPOuT9zAIBWJ3T0lE2wAAAAAElFTkSuQmCC";
