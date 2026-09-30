import type { FastifyRequest } from "fastify";
import { validateKey } from "./keys.js";
import { priceOf, creditsFor, FREE_DAILY_CALLS_PER_IP } from "./pricing.js";

/**
 * Decide whether a request may proceed WITHOUT an x402 payment.
 * Returns null when payment is required (the x402 middleware then takes over).
 */
export type AccessMethod = "free" | "api_key" | "quota" | "x402";
export interface Access { method: AccessMethod; payer: string | null; price: number }

export const FREE_MODE = process.env.INTEL_FREE === "1" || !process.env.X402_PAY_TO;

const freeCounter = new Map<string, { day: string; n: number }>();
function underFreeQuota(ip: string): boolean {
  const day = new Date().toISOString().slice(0, 10);
  const c = freeCounter.get(ip);
  if (!c || c.day !== day) { freeCounter.set(ip, { day, n: 1 }); return true; }
  c.n++; return c.n <= FREE_DAILY_CALLS_PER_IP;
}

/** Tool name for a request: REST path → tool, MCP → params.name (only tools/call is billable). */
export function toolForRequest(req: FastifyRequest): string | null {
  const url = req.url.split("?")[0];
  if (url === "/mcp" && req.method === "POST") {
    const b: any = req.body;
    if (!b || Array.isArray(b) || b.method !== "tools/call") return null;   // handshake, tools/list… free
    return String(b.params?.name ?? "");
  }
  if (url === "/v1/oracle/forecast" && req.method === "POST") return "oracle_forecast";
  if (url === "/v1/oracle/edge") return "polymarket_edge";
  if (url === "/v1/oracle/board/questions" || (url.startsWith("/v1/oracle/board") && req.method === "POST")) return null;  // free list / operator actions
  if (url === "/v1/oracle/board" || url.startsWith("/v1/oracle/board/")) return "oracle_board";
  if (url.startsWith("/v1/oracle/")) return null;   // GET forecast/{id}, track-record, resolve (operator key): free
  if (url.startsWith("/v1/events")) return "events_since";
  if (url.startsWith("/v1/impact/")) return "impact_for";
  if (url.startsWith("/v1/graph/")) return "exposure_graph";
  if (url === "/v1/regime") return "regime_snapshot";
  if (url.startsWith("/v1/explain/")) return "explain";
  if (url === "/v1/polymarket/top") return "polymarket_top";
  if (url.startsWith("/v1/polymarket/")) return "polymarket_context";
  if (url === "/v1/pulse") return "pulse";
  if (url.startsWith("/v1/news/")) return "news_for";
  if (url.startsWith("/v1/derivs/")) return "derivs_for";
  if (url.startsWith("/v1/price/")) return "price_for";
  if (url === "/v1/funding/alerts") return "funding_alerts";
  if (url === "/v1/whales") return "whale_moves";
  if (url.startsWith("/v1/filings/")) return "filings_for";
  if (url === "/v1/calendar") return "calendar";
  if (url.startsWith("/v1/brief/")) return "brief";
  if (url.startsWith("/v1/token/verdict/")) return "token_verdict";
  return null;
}

export function decideAccess(req: FastifyRequest): Access | null {
  const tool = toolForRequest(req);
  if (!tool) return { method: "free", payer: null, price: 0 };
  const price = priceOf(tool);
  if (price === 0 || FREE_MODE) return { method: "free", payer: null, price: 0 };
  const key = (req.headers["x-api-key"] as string | undefined)?.trim();
  if (key) {
    const v = validateKey(key);
    if (v && v.remaining >= creditsFor(tool)) return { method: "api_key", payer: `key:${v.id}`, price };
    // invalid or exhausted key → fall through to x402 (agent may still pay per call)
  }
  // Free daily quota is opt-in (header X-Free-Trial: 1) so that unauthenticated probes from indexers see a real 402.
  // MCP tools/call keeps the automatic quota (MCP clients can't easily add headers; registries probe initialize/tools/list only).
  const wantsTrial = String(req.headers["x-free-trial"] ?? "").trim() === "1" || (req.url.split("?")[0] === "/mcp");
  if (wantsTrial && !req.headers["payment-signature"] && !req.headers["x-payment"] && underFreeQuota(req.ip)) return { method: "quota", payer: req.ip, price: 0 };
  return null;
}
