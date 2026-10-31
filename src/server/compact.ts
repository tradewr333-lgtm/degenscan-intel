/**
 * "Code Mode" friendliness (Renato 31/10, Cloudflare Code Mode): agents connected to many MCP servers pay for every tool
 * description in context and for every round trip. Three answers, same data, same prices:
 *  1. Compact MCP (POST /mcp?mode=compact): two tools only — `search` (find the right tool, ~free) and `execute`
 *     (run it; billed at that tool's price). A few hundred tokens instead of 60+ tool descriptions.
 *  2. REST batch (POST /v1/batch): up to 10 GET routes in ONE request, priced at the sum, with optional field picking
 *     so only what matters comes back.
 *  3. TypeScript declarations (GET /sdk/degenscan-intel.d.ts): a typed API surface for agents that write code.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PRICES } from "./pricing.js";

const json = (x: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(x) }], structuredContent: x as Record<string, unknown> });
const fail = (msg: string) => ({ content: [{ type: "text" as const, text: `error: ${msg}` }], isError: true });
const words = (s: string) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 1);

export interface ToolInfo { tool: string; title: string | null; description: string; price_usd: number; input: any }
/** Tool catalog from a built MCP server (names, descriptions, JSON-Schema inputs, prices). */
export function toolCatalog(full: McpServer): ToolInfo[] {
  const reg = (full as any)._registeredTools as Record<string, any>;
  return Object.entries(reg).filter(([, t]) => t.enabled !== false).map(([tool, t]) => {
    let input: any = { type: "object", properties: {} };
    try { if (t.inputSchema) { const j: any = zodToJsonSchema(t.inputSchema, { target: "jsonSchema7" }); delete j.$schema; input = j; } } catch { /* keep empty */ }
    return { tool, title: t.title ?? null, description: String(t.description ?? ""), price_usd: PRICES[tool] ?? 0, input };
  });
}
/** Pure: rank tools by word overlap with the query (name words weigh 3×, title 2×, description 1×). Exported for tests. */
export function rankTools(cat: ToolInfo[], query: string, limit = 5) {
  const q = new Set(words(query)); if (!q.size) return [];
  const score = (t: ToolInfo) => { let s = 0; for (const w of words(t.tool)) if (q.has(w)) s += 3; for (const w of words(t.title ?? "")) if (q.has(w)) s += 2;
    for (const w of new Set(words(t.description))) if (q.has(w)) s += 1; return s; };
  return cat.map(t => ({ t, s: score(t) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.t.price_usd - b.t.price_usd).slice(0, Math.min(Math.max(limit, 1), 15))
    .map(({ t, s }) => ({ tool: t.tool, price_usd: t.price_usd, score: s, description: t.description.length > 400 ? t.description.slice(0, 397) + "…" : t.description, input: t.input }));
}

export function buildCompactServer(full: McpServer, version: string) {
  const reg = (full as any)._registeredTools as Record<string, any>;
  const cat = toolCatalog(full);
  const s = new McpServer({ name: "degenscan-intel-compact", version }, { instructions: [
    `Degenscan Intel, compact mode: ${cat.length} market-data tools behind two calls. 1) search(query) → the best-matching tools with price and input schema (free). 2) execute(tool, arguments) → runs that tool, billed at its own price (100 free calls/day per IP, then USDC via x402 or X-API-KEY).`,
    "Several data points at once over REST: POST /v1/batch {calls:[{path, fields?}]} — one request, priced at the sum. Typed API: GET /sdk/degenscan-intel.d.ts.",
    "Information and analytics only — not investment advice."].join("\n") });
  const ro = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
  s.registerTool("search", { title: "Search Degenscan tools", description: `Find the right Degenscan Intel tool for a task (e.g. "hyperliquid funding btc", "token honeypot base", "cheapest llm with vision"). Returns up to 15 tools with price_usd and the JSON-Schema of their arguments. Free.`,
    inputSchema: { query: z.string().describe("what you need, in a few words"), limit: z.number().int().min(1).max(15).optional() }, annotations: ro },
    async (a: any) => json({ query: a.query, results: rankTools(cat, a.query, a.limit ?? 5), total_tools: cat.length }));
  s.registerTool("execute", { title: "Execute a Degenscan tool", description: "Run one Degenscan Intel tool by name with its arguments (as returned by search). Billed at that tool's price.",
    inputSchema: { tool: z.string().describe("tool name from search"), arguments: z.record(z.any()).optional().describe("the tool's arguments") }, annotations: ro },
    async (a: any, extra: any) => {
      const t = reg[a.tool]; if (!t || t.enabled === false) return fail(`unknown tool ${a.tool}; call search first`);
      let args: any = a.arguments ?? {};
      if (t.inputSchema) { const p = await t.inputSchema.safeParseAsync(args); if (!p.success) return fail(`invalid arguments for ${a.tool}: ${p.error.issues.map((i: any) => `${i.path.join(".")} ${i.message}`).join("; ")}`); args = p.data; }
      return t.handler(args, extra);
    });
  return s;
}

/** Pure: keep only the requested dotted paths ("funding.apr_now", "price"). Exported for tests. */
export function pick(obj: any, fields?: unknown) {
  const f = Array.isArray(fields) ? fields.map(String).filter(Boolean).slice(0, 40) : [];
  if (!f.length || obj == null || typeof obj !== "object") return obj;
  const out: any = {};
  for (const path of f) {
    const parts = path.split("."); let src = obj; let ok = true;
    for (const p of parts) { if (src != null && typeof src === "object" && p in src) src = src[p]; else { ok = false; break; } }
    if (!ok) continue;
    let dst = out; parts.slice(0, -1).forEach(p => { dst = dst[p] ??= {}; }); dst[parts[parts.length - 1]] = src;
  }
  return out;
}

const tsType = (s: any): string => {
  if (!s || typeof s !== "object") return "any";
  if (s.enum) return s.enum.map((v: any) => JSON.stringify(v)).join(" | ");
  if (s.anyOf) return s.anyOf.map(tsType).join(" | ");
  if (s.type === "array") return `Array<${tsType(s.items)}>`;
  if (s.type === "object") { const props = s.properties ?? {}; const req = new Set(s.required ?? []);
    const keys = Object.keys(props); if (!keys.length) return s.additionalProperties ? "Record<string, any>" : "{}";
    return `{ ${keys.map(k => `${/^[a-z_$][\w$]*$/i.test(k) ? k : JSON.stringify(k)}${req.has(k) ? "" : "?"}: ${tsType(props[k])}`).join("; ")} }`; }
  if (s.type === "integer" || s.type === "number") return "number";
  if (s.type === "string") return "string";
  if (s.type === "boolean") return "boolean";
  return "any";
};
/** TypeScript declarations of every tool (for code-writing agents). */
export function typesFile(cat: ToolInfo[], base: string, version: string) {
  const doc = (t: ToolInfo) => `  /** ${t.description.replace(/\*\//g, "* /").slice(0, 600)}\n   * Price: US$${t.price_usd} per call (USDC via x402, Base or Solana; or X-API-KEY). */`;
  return `// Degenscan Intel ${version} — typed tool surface. Generated from the live MCP registry.
// Call over MCP: POST ${base}/mcp (tools/call {name, arguments}) or compact mode POST ${base}/mcp?mode=compact (execute {tool, arguments}).
// Several calls in one request: POST ${base}/v1/batch {"calls":[{"path":"/v1/coin/BTC","fields":["price","funding"]}]}.
// Information and analytics only — not investment advice.
export interface DegenscanIntelTools {
${cat.map(t => `${doc(t)}\n  ${t.tool}(args: ${tsType(t.input)}): Promise<any>;`).join("\n")}
}
export declare const PRICES_USD: { ${cat.map(t => `${t.tool}: ${t.price_usd}`).join("; ")} };
`;
}
