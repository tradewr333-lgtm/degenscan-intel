import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { gate } from "./x402.js";
import { PRICES } from "./pricing.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, TOOL_DOCS } from "./tools.js";
import { CONNECTORS } from "../ingest/registry.js";
import { getDb } from "../store/db.js";

export function buildHttp() {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false, trustProxy: true });

  app.get("/", async () => ({
    name: "degenscan-intel", version: "0.1.0",
    description: "Cross-asset event intelligence for autonomous agents. Pay per call with USDC (x402) or an API key.",
    mcp: "/mcp", rest: "/v1", pricing: TOOL_DOCS, docs: "https://github.com/tradewr333-lgtm/degenscan-intel", contact: "contact@degenscan.io",
  }));
  app.get("/health", async () => {
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number }).n;
    return { ok: true, events: n, connectors: CONNECTORS.length, at: new Date().toISOString() };
  });
  // llms.txt so agents discover us
  app.get("/llms.txt", async (_r, reply) => reply.type("text/plain").send(
    `# degenscan-intel\n> Cross-asset event feed for trading agents. MCP at /mcp (streamable HTTP). REST at /v1.\n\n## Tools\n${TOOL_DOCS.map(t => `- ${t.tool}: $${t.price_usd} per call`).join("\n")}\n\n## Payment\nx402 (USDC on Base) — call without X-PAYMENT to receive requirements; or X-API-KEY.\n`));

  // ---- REST mirror (each route gated by the same price as the MCP tool)
  const rest = <T>(tool: string, fn: (q: any) => T) => async (req: any, reply: any) => {
    const ctx = await gate(tool, req, reply); if (!ctx) return;
    try { return { ...(fn({ ...req.query, ...(req.body ?? {}) }) as any), _billing: { tool, price_usd: ctx.price, method: ctx.method } }; }
    catch (e) { reply.code(400); return { error: (e as Error).message }; }
  };
  const coerce = (q: any) => ({ ...q, universe: typeof q.universe === "string" ? q.universe.split(",") : q.universe, kinds: typeof q.kinds === "string" ? q.kinds.split(",") : q.kinds,
    min_severity: q.min_severity != null ? Number(q.min_severity) : undefined, min_confidence: q.min_confidence != null ? Number(q.min_confidence) : undefined, limit: q.limit != null ? Number(q.limit) : undefined, depth: q.depth != null ? Number(q.depth) : undefined });
  app.get("/v1/events", rest("events_since", q => eventsSince(EventsSinceArgs.parse(coerce(q)))));
  app.post("/v1/events", rest("events_since", q => eventsSince(EventsSinceArgs.parse(coerce(q)))));
  app.get("/v1/impact/:asset_id", async (req: any, reply) => rest("impact_for", q => impactFor(ImpactForArgs.parse({ ...coerce(q), asset_id: req.params.asset_id })))(req, reply));
  app.get("/v1/graph/:asset_id", async (req: any, reply) => rest("exposure_graph", q => exposureGraph(ExposureGraphArgs.parse({ ...coerce(q), asset_id: req.params.asset_id })))(req, reply));
  app.get("/v1/regime", rest("regime_snapshot", () => regimeSnapshot()));
  app.get("/v1/explain/:event_id", async (req: any, reply) => rest("explain", () => explain(req.params.event_id))(req, reply));
  app.get("/v1/universe", async () => universe());
  app.get("/v1/sources", async () => sources());

  // ---- MCP (stateless streamable HTTP). tools/call requests are gated by tool price.
  app.post("/mcp", async (req: any, reply) => {
    const body = req.body;
    const isCall = body && !Array.isArray(body) && body.method === "tools/call";
    if (isCall) {
      const tool = String(body.params?.name ?? "");
      if ((PRICES[tool] ?? 0.005) > 0) { const ctx = await gate(tool, req, reply); if (!ctx) return; }
    }
    const server = buildMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(req.raw, reply.raw, body);
    reply.raw.on("close", () => { transport.close(); server.close(); });
  });
  app.get("/mcp", async (_r, reply) => reply.code(405).send({ error: "stateless server: use POST" }));
  app.delete("/mcp", async (_r, reply) => reply.code(405).send({ error: "stateless server" }));

  return app;
}
