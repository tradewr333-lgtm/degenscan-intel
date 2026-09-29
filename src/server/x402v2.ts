import type { FastifyInstance } from "fastify";
import { paymentMiddlewareFromHTTPServer, x402HTTPResourceServer, x402ResourceServer } from "@x402/fastify";
import type { RoutesConfig, RouteConfig } from "@x402/core/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { registerExactSvmScheme } from "@x402/svm/exact/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { PRICES } from "./pricing.js";
import { PACKS } from "./keys.js";
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
    "GET /v1/impact/*": {
      accepts: accept("impact_for"), description: "Net directional pressure on one asset from recent events, with the source events.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } },
        output: { example: { asset: { id: "NVDA", class: "equity" }, n_events: 3, net_score: -0.42, bias: -0.7, top: [] } } }),
    },
    "GET /v1/graph/*": {
      accepts: accept("exposure_graph"), description: "Exposure sub-graph around an asset: suppliers, customers, countries, commodities, regulators, correlated assets, critical facilities.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { depth: 2 }, inputSchema: { properties: { depth: { type: "number" } } }, output: { example: { root: "company:NVDA", nodes: ["company:TSM", "asset:NDX"], edges: [] } } }),
    },
    "GET /v1/regime": {
      accepts: accept("regime_snapshot"), description: "Market regime snapshot: venues open now, 24h event pressure by asset, high-severity events, prediction-market context.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { venues_open: { crypto: true, US: false }, events_24h: 43, pressure: [{ asset_id: "BA", n: 10, net: 0 }] } } }),
    },
    "GET /v1/explain/*": {
      accepts: accept("explain"), description: "Human-readable rationale for one event's impacts.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { explanation: "…" } } }),
    },
    "GET /v1/pulse": {
      accepts: accept("pulse"), description: "Cheapest probe: last-hour event counts by class, top-3 severe events with impacts, venues open. Call hourly or as a health check before deeper calls.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { window: "1h", events: 42, by_class: { reg: 6, corp: 18, crypto: 4, media: 14 }, high_severity: 2, venues_open: { crypto: true, us_equities: false } } } }),
    },
    "GET /v1/news/*": {
      accepts: accept("news_for"), description: "Headlines touching one asset (press wires, releases, halts, hacks, media) with source tier, corroboration and a heuristic sentiment score (-1..1). Links only, no bodies.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "24h", limit: 25 }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } }, output: { example: { asset: { id: "NVDA" }, count: 3, sentiment_avg: 0.25, sentiment_label: "positive", items: [{ title: "NVIDIA announces…", tier: "primary", sentiment: 0.5, url: "https://…" }] } } }),
    },
    "GET /v1/price/*": {
      accepts: accept("price_for"), description: "Price probe for one coin, no key: Hyperliquid perp mark/mid/oracle + Coinbase spot, 24h change, basis, funding, plus links to our event pressure on the asset. ~1 KB, 30 s cache — made for polling.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ output: { example: { symbol: "BTC", perp: { mark: 83102, change_24h_pct: -1.76, funding_1h: 0.0000125 }, spot: { venue: "coinbase", price: 83090 }, basis_pct: 0.0144 } } }),
    },
    "GET /v1/funding/alerts": {
      accepts: accept("funding_alerts"), description: "Coins with extreme perp funding right now on Hyperliquid, sorted by |rate|, with annualized %, side paying, open interest and predicted funding per venue (Binance, Bybit, Hyperliquid). Poll every 5–15 min to catch crowded positioning.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { min_abs_rate_1h: 0.0003, limit: 15 }, inputSchema: { properties: { min_abs_rate_1h: { type: "number" }, limit: { type: "number" } } }, output: { example: { count: 2, alerts: [{ symbol: "HYPE", funding_1h: 0.0008, annualized_pct: 700.8, side_paying: "longs", open_interest_usd: 1798314282 }] } } }),
    },
    "GET /v1/whales": {
      accepts: accept("whale_moves"), description: "Large stablecoin transfers (USDC/USDT) on Base and Ethereum from public explorers, no key: size in USD, best-effort exchange labels, flow tag (to_exchange / from_exchange / mint / burn / wallet_to_wallet), totals by flow. 60 s cache.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { min_usd: 1000000, limit: 25 }, inputSchema: { properties: { min_usd: { type: "number" }, chains: { type: "string" }, limit: { type: "number" } } }, output: { example: { count: 3, totals_usd: { to_exchange: 25000000, from_exchange: 0 }, moves: [{ chain: "ethereum", token: "USDC", usd: 25000000, from_label: "unlabeled", to_label: "Coinbase 10", flow: "to_exchange" }] } } }),
    },
    "GET /v1/polymarket/top": {
      accepts: accept("polymarket_top"), description: "Most active Polymarket markets right now: YES odds, 24h change, 24h volume, liquidity, end date, and a link to our primary-source evidence pack per market. Sort by volume, liquidity or 24h change; optional tag filter (crypto, fed, politics).", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { sort: "volume_24h", limit: 20 }, inputSchema: { properties: { sort: { type: "string" }, limit: { type: "number" }, tag: { type: "string" } } }, output: { example: { count: 20, markets: [{ question: "Fed rate cut in October?", yes_prob: 0.62, change_24h: 0.03, volume_24h_usd: 1250000 }] } } }),
    },
    "GET /v1/derivs/*": {
      accepts: accept("derivs_for"), description: "Perpetual-futures microstructure for one coin from Hyperliquid's public API: funding (1h, 8h-equivalent, annualized), predicted funding by venue, open interest (coins/USD, OI-to-volume), premium vs oracle, 24h volume, 24h change, flags, plus our primary-source event pressure on the same asset.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" } } }, output: { example: { symbol: "BTC", funding: { rate_1h: 0.0000125, annualized_pct: 10.95 }, open_interest: { usd: 1250000000 }, price: { mark: 65000, premium_vs_oracle: 0.0002 }, flags: [], event_pressure: { bias: 0.2, n_events: 4 } } } }),
    },
    "GET /v1/filings/*": {
      accepts: accept("filings_for"), description: "SEC EDGAR filings touching one US issuer: 8-K by item, Form 4 insider trades, 13D/G activist stakes, S-1 offerings, with impact direction and link. Public-domain source.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "7d" }, inputSchema: { properties: { since: { type: "string" }, forms: { type: "string" } } }, output: { example: { asset: { id: "COIN" }, count: 1, filings: [{ kind: "corp.8k", title: "COINBASE GLOBAL files 8-K — Results of operations", url: "https://www.sec.gov/…" }] } } }),
    },
    "GET /v1/calendar": {
      accepts: accept("calendar"), description: "Upcoming scheduled catalysts: US macro prints (CPI, jobs, PCE, GDP…) with ET times, FOMC decisions/minutes, Treasury auctions and earnings dates, each with the assets it usually moves.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { days: 7 }, inputSchema: { properties: { days: { type: "number" }, types: { type: "string" } } }, output: { example: { count: 2, items: [{ at: "2026-10-14T12:30:00.000Z", type: "macro", name: "Consumer Price Index (CPI)", affects: ["US10Y", "SPX", "BTC"] }] } } }),
    },
    "GET /v1/brief/*": {
      accepts: accept("brief"), description: "Premium one-call pre-trade briefing for an asset: net pressure and drivers, headlines with sentiment, SEC filings, exposure map, related Polymarket odds, upcoming catalysts, venue status. Replaces six calls.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "24h" }, inputSchema: { properties: { since: { type: "string" } } }, output: { example: { asset: { id: "MSTR" }, pressure: { bias: -0.4, n_events: 5 }, headlines: { sentiment_avg: -0.2 }, upcoming_catalysts: [{ name: "FOMC Rate Decision" }], tradable_now: ["crypto"] } } }),
    },
    "GET /v1/polymarket/*": {
      accepts: accept("polymarket_context"), description: "Evidence pack for one Polymarket market: current odds plus the primary-source events (Fed, SEC, agencies, disasters, hacks) in our feed that bear on the question, with relevance and corroboration. For agents trading or quoting prediction markets.", mimeType: "application/json", ...common,
      extensions: declareDiscoveryExtension({ input: { since: "48h", limit: 15 }, inputSchema: { properties: { since: { type: "string" }, limit: { type: "number" } } }, output: { example: { market: { question: "Fed rate cut in October?", yes_prob: 0.62, change_24h: 0.03 }, n_related: 2, related: [{ kind: "cb.speech", title: "Fed Governor: inflation progress supports easing", tier: "primary", relevance: 0.5 }] } } }),
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
