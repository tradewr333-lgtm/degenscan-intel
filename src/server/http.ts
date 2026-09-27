import Fastify from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.js";
import { PRICES } from "./pricing.js";
import { EventsSinceArgs, ImpactForArgs, ExposureGraphArgs, eventsSince, impactFor, exposureGraph, universe, sources, regimeSnapshot, explain, TOOL_DOCS } from "./tools.js";
import { CONNECTORS } from "../ingest/registry.js";
import { getDb, recordCall } from "../store/db.js";
import { decideAccess, toolForRequest, type Access } from "./access.js";
import { installX402 } from "./x402v2.js";
import { FastifyAdapter } from "@x402/fastify";
import { installStripe } from "./stripe.js";

declare module "fastify" { interface FastifyRequest { intelAccess?: Access } }

export async function buildHttp() {
  const app = Fastify({ logger: process.env.LOG_LEVEL ? { level: process.env.LOG_LEVEL } : false, trustProxy: true });
  const PUBLIC_URL = process.env.PUBLIC_URL ?? "https://degenscan-intel.onrender.com";

  // 1) Our access decision runs first (onRequest, before the x402 hook) and marks the request.
  //    POST /mcp is decided later, once the JSON-RPC body is parsed (see the /mcp handler).
  app.addHook("onRequest", async (req) => {
    if (req.url.startsWith("/mcp")) { (req.headers as any)["x-intel-access"] = "mcp"; return; }
    const a = decideAccess(req);
    req.intelAccess = a ?? undefined;
    (req.headers as any)["x-intel-access"] = a ? a.method : "pay";
  });
  // 2) x402 v2 (+v1) payment middleware — 402s any REST route not marked as authorized.
  const x402 = await installX402(app);
  // 3) Billing log after the response.
  app.addHook("onResponse", async (req, reply) => {
    const tool = toolForRequest(req); if (!tool || reply.statusCode >= 400) return;
    if (req.x402Context) recordCall(tool, `x402:${(req.x402Context.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, PRICES[tool] ?? 0.005, true);
    else if (req.intelAccess && req.intelAccess.method !== "free") recordCall(tool, req.intelAccess.payer, req.intelAccess.price, true);
  });
  const billing = (req: any, tool: string) => req.x402Context ? { tool, price_usd: PRICES[tool] ?? 0.005, method: "x402" } : { tool, price_usd: req.intelAccess?.price ?? 0, method: req.intelAccess?.method ?? "free" };

  app.get("/", async () => ({
    name: "degenscan-intel", version: "0.2.0",
    description: "Cross-asset event intelligence for autonomous agents. Pay per call with USDC (x402 v2, Base) or subscribe with an API key.",
    mcp: `${PUBLIC_URL}/mcp`, rest: `${PUBLIC_URL}/v1`, pricing: TOOL_DOCS, plans: `${PUBLIC_URL}/v1/plans`, docs: "https://github.com/tradewr333-lgtm/degenscan-intel", contact: "contact@degenscan.io",
  }));
  app.get("/health", async () => {
    const n = (getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as unknown as { n: number }).n;
    return { ok: true, events: n, connectors: CONNECTORS.length, at: new Date().toISOString() };
  });
  app.get("/icon.png", async (_r, reply) => reply.type("image/png").send(Buffer.from(ICON_PNG_B64, "base64")));
  // Glama ownership challenge (https://glama.ai) — token is account-bound, contains no secrets; overridable via env.
  app.get("/.well-known/glama.json", async () => ({ $schema: "https://glama.ai/mcp/schemas/connector.json", claim: process.env.GLAMA_CLAIM ?? "glama_claim__jjuT9diA1oBYRDhpNvBl7A9aD4RRMbR" }));
  app.get("/llms.txt", async (_r, reply) => reply.type("text/plain").send(
    `# Degenscan Intel\n> Cross-asset event intelligence for trading agents: SEC, Fed, Federal Register, USGS, NHC, Nasdaq halts, DefiLlama, Polymarket and 30+ more primary sources normalized into one event schema and scored against an exposure graph into per-asset impacts.\n\n## Endpoints\n- MCP (streamable HTTP): POST ${PUBLIC_URL}/mcp\n- REST: ${PUBLIC_URL}/v1/events?since=4h&universe=NVDA,BTC · /v1/impact/{asset} · /v1/graph/{asset} · /v1/regime · /v1/explain/{event_id} · /v1/universe (free) · /v1/sources (free)\n\n## Pricing\n${TOOL_DOCS.map(t => `- ${t.tool}: $${t.price_usd} per call`).join("\n")}\n- 100 free calls/day per IP, then HTTP 402 with x402 v2 payment requirements (USDC on Base, eip155:8453). Or subscribe: ${PUBLIC_URL}/v1/plans (X-API-KEY header).\n\n## Schema\nEvent { id, ts_event, kind, title, summary, entities[], severity, novelty, impacts[{asset_id, direction:-1|0|1, confidence, horizon, path[], rationale}], tradable_now[], next_open[], source{tier}, corroboration }\n`));

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
  app.get("/v1/universe", async () => universe());
  app.get("/v1/sources", async () => sources());

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
          .then(s => { const tool = toolForRequest(req) ?? "mcp"; recordCall(tool, `x402:${(v.paymentPayload as any)?.payload?.authorization?.from ?? "unknown"}`, PRICES[tool] ?? 0.005, s.success); if (!s.success) console.warn("[x402/mcp] settle failed:", s.errorReason); })
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
