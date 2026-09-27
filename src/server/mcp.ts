import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain } from "./tools.js";
import { PRICES } from "./pricing.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }], structuredContent: x as Record<string, unknown> });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true });

/** Build the MCP server. One instance per stateless HTTP request is fine (cheap). */
export function buildMcpServer() {
  const s = new McpServer({ name: "degenscan-intel", version: "0.3.0" }, {
    instructions: [
      "Degenscan Intel: cross-asset event feed for trading agents. Events are normalized from ~40 primary sources (SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket…) and scored against an exposure graph into per-asset impacts.",
      "Typical loop: regime_snapshot → events_since(since='4h', universe=[your book]) → impact_for(asset_id) for anything with confidence ≥ 0.4 → check tradable_now / next_open before acting.",
      `Pricing per call (USDC via x402, or API key): ${Object.entries(PRICES).map(([k, v]) => `${k}=$${v}`).join(", ")}. universe and sources_status are free.`,
      "Direction: 1 supportive, -1 negative, 0 unclear. Confidence is a 0..1 product of source tier, event severity/novelty and graph path weight — not a probability.",
      "Access: initialize/tools/list/universe/sources_status are free. Priced tools: 100 free calls/day per IP, then pay per call with x402 (USDC on Base) or send X-API-KEY. Autonomous agents can buy a prepaid key with USDC (no human): POST /v1/keys/x402/pack_1k ($5 = 1,000 calls). Details: /llms.txt.",
      "Information and analytics only — not investment advice.",
    ].join("\n"),
  });

  s.registerTool("events_since", {
    title: "Events since", description: `List market-moving events since a point in time (natural disasters, regulator actions, central-bank releases, federal rules, SEC filings, trading halts, on-chain hacks, prediction-market shifts), each scored into per-asset impacts (direction −1/0/+1, confidence 0..1, horizon) with tradable_now / next_open per asset. Use it to answer "what happened in the last N hours that affects my book" or, with a past \`since\`, to backtest. Filter with universe=["NVDA","BTC"] and min_confidence≥0.4 to act on. $${PRICES.events_since}/call; 100 free calls/day.`,
    inputSchema: EventsSinceArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(eventsSince(EventsSinceArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("impact_for", {
    title: "Impact for asset", description: `Net directional pressure on ONE asset over a window: bias (−1..+1), number of events, strongest supportive and negative drivers, and the source events with rationale and graph path. Use it before entering or sizing a position in that asset, or to explain a move ("why is MSTR down today?"). $${PRICES.impact_for}/call.`,
    inputSchema: ImpactForArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(impactFor(ImpactForArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("exposure_graph", {
    title: "Exposure graph", description: `Who and what an asset is exposed to: suppliers, customers, countries of revenue/production, input commodities, regulators, indices that hold it, correlated assets and critical facilities (fabs, ports, straits) with coordinates. Use it to find second-order trades (an event on TSM → NVDA, AAPL) or to know which regulators/countries to watch for a holding. $${PRICES.exposure_graph}/call.`,
    inputSchema: ExposureGraphArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(exposureGraph(ExposureGraphArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("regime_snapshot", {
    title: "Regime snapshot", description: `One-call situational picture for right now: which venues are open (US equities, futures, FX, crypto) and the next opens, 24h event pressure ranked by asset, the highest-severity events, and prediction-market probabilities (Fed, shutdown, tariffs…). Call it first in a session, or every few hours, to decide whether to look deeper. $${PRICES.regime_snapshot}/call.`,
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => { try { return json(regimeSnapshot()); } catch (e) { return fail(e); } });

  s.registerTool("explain", {
    title: "Explain event", description: `Plain-language explanation of ONE event's impacts: why each asset got its direction and confidence, the exposure-graph path used, the source document link and corroborating sources. Use it when an impact from events_since/impact_for is surprising and you need the reasoning before acting, or to log a rationale. Takes the event id from those tools. $${PRICES.explain}/call.`,
    inputSchema: { event_id: z.string() }, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(explain(a.event_id)); } catch (e) { return fail(e); } });

  s.registerTool("universe", {
    title: "Universe", description: "List every asset id the service scores (top-100 US equities by volume, indices/ETFs, 15 crypto, commodities, FX, rates) with class, name and exposure tags, plus the universe version stamped on every response. Call it once to map your tickers to asset ids before using the other tools. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => json(universe()));

  s.registerTool("sources_status", {
    title: "Sources status", description: "Transparency report on the ~40 data connectors: tier (primary/media), cadence, last successful run, items ingested, last error. Use it to judge freshness before trusting a quiet feed, or to see which sources are best-effort. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => json(sources()));

  return s;
}
