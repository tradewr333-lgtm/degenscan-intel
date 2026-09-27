import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain } from "./tools.js";
import { PRICES } from "./pricing.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }], structuredContent: x as Record<string, unknown> });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${(e as Error).message}` }], isError: true });

/** Build the MCP server. One instance per stateless HTTP request is fine (cheap). */
export function buildMcpServer() {
  const s = new McpServer({ name: "degenscan-intel", version: "0.1.0" }, {
    instructions: [
      "Degenscan Intel: cross-asset event feed for trading agents. Events are normalized from ~40 primary sources (SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket…) and scored against an exposure graph into per-asset impacts.",
      "Typical loop: regime_snapshot → events_since(since='4h', universe=[your book]) → impact_for(asset_id) for anything with confidence ≥ 0.4 → check tradable_now / next_open before acting.",
      `Pricing per call (USDC via x402, or API key): ${Object.entries(PRICES).map(([k, v]) => `${k}=$${v}`).join(", ")}. universe and sources_status are free.`,
      "Direction: 1 supportive, -1 negative, 0 unclear. Confidence is a 0..1 product of source tier, event severity/novelty and graph path weight — not a probability.",
    ].join("\n"),
  });

  s.registerTool("events_since", {
    title: "Events since", description: `What happened in the world since <since> that affects the universe. $${PRICES.events_since}/call.`,
    inputSchema: EventsSinceArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(eventsSince(EventsSinceArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("impact_for", {
    title: "Impact for asset", description: `Aggregated directional pressure on one asset from recent events, with the source events. $${PRICES.impact_for}/call.`,
    inputSchema: ImpactForArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(impactFor(ImpactForArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("exposure_graph", {
    title: "Exposure graph", description: `Sub-graph of suppliers, customers, countries, commodities, regulators and correlated assets around an asset. $${PRICES.exposure_graph}/call.`,
    inputSchema: ExposureGraphArgs.shape, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(exposureGraph(ExposureGraphArgs.parse(a))); } catch (e) { return fail(e); } });

  s.registerTool("regime_snapshot", {
    title: "Regime snapshot", description: `Which venues are open now, 24h event pressure by asset, high-severity events, prediction-market context. $${PRICES.regime_snapshot}/call.`,
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => { try { return json(regimeSnapshot()); } catch (e) { return fail(e); } });

  s.registerTool("explain", {
    title: "Explain event", description: `Human-readable rationale for one event's impacts. $${PRICES.explain}/call.`,
    inputSchema: { event_id: z.string() }, annotations: { readOnlyHint: true },
  }, async (a) => { try { return json(explain(a.event_id)); } catch (e) { return fail(e); } });

  s.registerTool("universe", {
    title: "Universe", description: "Current asset universe (top-100 US equities by volume + indices/ETFs + crypto + commodities/FX/rates) with ids and tags. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => json(universe()));

  s.registerTool("sources_status", {
    title: "Sources status", description: "Health, cadence and last run of every connector. Free.",
    inputSchema: {}, annotations: { readOnlyHint: true },
  }, async () => json(sources()));

  return s;
}
