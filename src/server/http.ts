import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { PRICES } from "./pricing.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, PolymarketContextArgs, NewsArgs, FilingsArgs, CalendarArgs, BriefArgs, DerivsArgs, PriceArgs, FundingAlertsArgs, WhaleArgs, PolyTopArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, polymarketContext, pulse, newsFor, filingsFor, calendar, brief, derivsFor, priceFor, fundingAlerts, whaleMoves, polymarketTop, TOOL_DOCS } from "./tools.js";
import { CONNECTORS } from "../ingest/registry.js";
import { DB_PATH, getDb, recordCall, weeklyMetrics } from "../store/db.js";
import { decideAccess, toolForRequest, FREE_MODE, type Access } from "./access.js";
import { PACKS, createPackKey, activatePackKey, dropPendingKey, keyStatus, type Pack } from "./keys.js";
import { installX402, PAY_TO_SOLANA, SOLANA_NETWORK } from "./x402v2.js";
import { installDocs } from "./docs.js";
import { installOracleRoutes } from "./oracle-routes.js";
import { FastifyAdapter } from "@x402/fastify";
import { installStripe } from "./stripe.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

declare module "fastify" { interface FastifyRequest { intelAccess?: Access; pendingKeyId?: string; purchasedPack?: Pack } }

const OPERATOR = "Marbella Collins LLC (Florida, USA) — contact@degenscan.io";
const DISCLAIMER = "Information and analytics only — not investment advice. Impact scores are deterministic heuristics over public events, with no guarantee of accuracy or timeliness. You are solely responsible for your trading decisions.";
const METRICS_SINCE = process.env.METRICS_SINCE ?? "2026-09-27T00:00:00Z";
/** Owner/test wallets: never counted as customers or revenue in public metrics. */
const EXCLUDED_WALLETS = (process.env.EXCLUDED_WALLETS ?? "0x5344722b8D037827A9a5b7cD6312481D215d33BF,0x21f4A2DA07bccE60878cAb223358D11aD8F11a94").split(",").map(s => s.trim()).filter(Boolean);

const REST_FOR: Record<string, string> = { events_since: "/v1/events?since=4h&universe=NVDA,BTC", impact_for: "/v1/impact/{asset_id}?since=24h", exposure_graph: "/v1/graph/{asset_id}?depth=2", regime_snapshot: "/v1/regime", explain: "/v1/explain/{event_id}", polymarket_context: "/v1/polymarket/{market}?since=48h", pulse: "/v1/pulse", news_for: "/v1/news/{ticker}?since=24h", derivs_for: "/v1/derivs/{symbol}", price_for: "/v1/price/{symbol}", funding_alerts: "/v1/funding/alerts", whale_moves: "/v1/whales?min_usd=1000000", polymarket_top: "/v1/polymarket/top?sort=volume_24h", filings_for: "/v1/filings/{ticker}?since=7d", calendar: "/v1/calendar?days=7", brief: "/v1/brief/{asset_id}", oracle_board: "/v1/oracle/board", oracle_forecast: "/v1/oracle/forecast" };
const OPENAPI = (base: string) => ({
  openapi: "3.1.0",
  info: { title: "Degenscan Intel", version: "0.10.2", description: "Cross-asset market event intelligence for AI trading agents. Priced routes return HTTP 402 with x402 v2 payment requirements (USDC on Base) unless X-API-KEY is sent or the free trial header X-Free-Trial: 1 is present (100 calls/day/IP). Information and analytics only — not investment advice.", contact: { name: "Marbella Collins LLC", email: "contact@degenscan.io" }, license: { name: "MIT" } },
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
    "/v1/oracle/board": { get: { summary: "Oracle: daily board of standing forecasts (cached, no LLM) — probability, interval, base rate, market odds, edge per question", "x-price-usd": PRICES.oracle_board, responses: { "200": { description: "items[]" }, "402": { description: "payment required" } } } },
    "/v1/oracle/board/{slug}": { get: { summary: "Oracle: one board forecast with full payload and history", "x-price-usd": PRICES.oracle_board, parameters: [{ name: "slug", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Forecast + history[]" }, "402": { description: "payment required" } } } },
    "/v1/oracle/track-record": { get: { summary: "Oracle: public Brier track record overall, by domain and vs. market (free)", responses: { "200": { description: "brier, vs_market, by_domain, recent[]" } } } },
    "/v1/universe": { get: { summary: "Asset universe (free)", responses: { "200": { description: "assets[]" } } } },
    "/v1/sources": { get: { summary: "Connector health (free)", responses: { "200": { description: "sources[]" } } } },
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
      if (ok) { activatePackKey(req.pendingKeyId, tx); const pack = req.purchasedPack ?? "pack_1k"; recordCall("key_purchase", `x402:${(req.x402Context?.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, PACKS[pack]?.usd ?? 0, true, tx); }
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
    name: "degenscan-intel", version: "0.10.2",
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
  app.get("/health", async () => {
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number }).n;
    const calls = (getDb().prepare("SELECT COUNT(*) AS n FROM calls").get() as unknown as { n: number }).n;
    return { ok: true, events: n, calls, connectors: CONNECTORS.length, storage: { path: DB_PATH, persistent: DB_PATH.startsWith("/data/") }, at: new Date().toISOString() };
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
  // Owner/test wallets, published so explorers and buyers can verify our usage metrics exclude self-payments.
  app.get("/wallets.json", async () => ({ operator: OPERATOR, pay_to: PAY_TO, pay_to_solana: PAY_TO_SOLANA, owned_or_test_wallets: EXCLUDED_WALLETS, note: "Payments from these addresses are the operator's own tests; they are excluded from customers and revenue in /v1/metrics." }));
  app.get("/openapi.json", async () => OPENAPI(PUBLIC_URL));
  app.get("/favicon.ico", async (_r, reply) => reply.type("image/png").header("cache-control", "public, max-age=86400").send(Buffer.from(ICON_PNG_B64, "base64")));
  app.get("/icon.png", async (_r, reply) => reply.type("image/png").send(Buffer.from(ICON_PNG_B64, "base64")));
  // Glama ownership challenge (https://glama.ai) — token is account-bound, contains no secrets; overridable via env.
  app.get("/.well-known/glama.json", async () => ({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: process.env.GLAMA_CLAIM ?? "glama_claim__jjuT9diA1oBYRDhpNvBl7A9aD4RRMbR" }));
  installDocs(app, PUBLIC_URL);
  installOracleRoutes(app, billing);
  app.get("/llms.txt", async (_r, reply) => reply.type("text/plain").send(
    `# Degenscan Intel\n> Cross-asset event intelligence for trading agents: SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket and 30+ more primary sources normalized into one event schema and scored against an exposure graph into per-asset impacts.\n\n## Endpoints\n- MCP (streamable HTTP): POST ${PUBLIC_URL}/mcp\n- REST: ${PUBLIC_URL}/v1/pulse ($0.001 probe) · /v1/events?since=4h&universe=NVDA,BTC · /v1/impact/{asset} · /v1/graph/{asset} · /v1/regime · /v1/explain/{event_id} · /v1/polymarket/{market}?since=48h · /v1/news/{ticker} · /v1/price/{symbol} ($0.001, no key) · /v1/funding/alerts ($0.001) · /v1/whales ($0.002) · /v1/polymarket/top ($0.002) · /v1/derivs/{symbol} (perp funding/OI, Hyperliquid) · /v1/filings/{ticker} · /v1/calendar?days=7 · /v1/brief/{asset} ($0.10 premium, replaces 6 calls) · POST /v1/oracle/forecast ($0.25, async: calibrated probability for a binary question, Monte Carlo agent societies + expert panel, public Brier record) · /v1/oracle/board ($0.002, daily standing forecasts) · /v1/oracle/track-record (free) · /v1/universe (free) · /v1/sources (free)\n\n## Pricing\n${TOOL_DOCS.map(t => `- ${t.tool}: $${t.price_usd} per call`).join("\n")}\n- Free trial: send header  X-Free-Trial: 1  for 100 free calls/day per IP on REST (MCP tools/call gets it automatically). Without it, priced routes answer HTTP 402 with x402 v2 payment requirements (USDC on Base, eip155:8453). Or buy a prepaid key with USDC, no human needed: POST ${PUBLIC_URL}/v1/keys/x402/pack_1k → $5 for 1,000 calls (pack_10k $40, pack_100k $300), lifetime budget, check balance at /v1/keys/me. Or subscribe with a card: ${PUBLIC_URL}/v1/plans. Both give an X-API-KEY header.\n\n## SDKs\n- JavaScript/TypeScript: npm i @degenscan/intel  →  new Intel({ privateKey | apiKey }).eventsSince({ since: "4h", universe: ["NVDA","BTC"] })\n- Python: pip install degenscan-intel  →  Intel(private_key=... | api_key=...).events_since(since="4h", universe=["NVDA","BTC"])\nBoth pay the 402 automatically (USDC on Base) or send X-API-KEY.\n\n## Docs (one page per question, with curl/JS/Python)\n${PUBLIC_URL}/docs · full text: ${PUBLIC_URL}/llms-full.txt\n\n## Agent skill\n${PUBLIC_URL}/skill.md — when to call which tool, recommended loop, how to pay.\n\n## Operator\n${OPERATOR}. Public usage metrics: ${PUBLIC_URL}/v1/metrics (JSON) · ${PUBLIC_URL}/v1/metrics.csv\n\n## Disclaimer\n${DISCLAIMER}\n\n## Schema\nEvent { id, ts_event, kind, title, summary, entities[], severity, novelty, impacts[{asset_id, direction:-1|0|1, confidence, horizon, path[], rationale}], tradable_now[], next_open[], source{tier}, corroboration }\n`));

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
    const server = buildMcpServer();
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
