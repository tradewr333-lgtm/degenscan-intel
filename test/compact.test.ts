import { describe, it, expect } from "vitest";
import { rankTools, pick, typesFile, toolCatalog } from "../src/server/compact.js";
import { mcpToolName, batchPaths } from "../src/server/access.js";
import { batchPrice } from "../src/server/x402v2.js";
import { buildMcpServer } from "../src/server/mcp.js";
import { buildHttp } from "../src/server/http.js";
const parseSse = (b: string) => { const l = b.split("\n").find(x => x.startsWith("data:")); return JSON.parse(l ? l.slice(5) : b); };
describe("code-mode friendliness", () => {
  it("search ranks the right tools", () => {
    const cat = toolCatalog(buildMcpServer());
    expect(cat.length).toBe(62);
    expect(rankTools(cat, "hyperliquid funding rate", 5).map(r => r.tool)).toContain("funding_alerts");
    expect(rankTools(cat, "token honeypot risk", 3).map(r => r.tool)).toEqual(expect.arrayContaining(["token_risk"]));
    expect(rankTools(cat, "", 3)).toEqual([]);
  });
  it("billing of compact calls", () => {
    expect(mcpToolName({ params: { name: "search", arguments: { query: "x" } } })).toBeNull();
    expect(mcpToolName({ params: { name: "execute", arguments: { tool: "pulse" } } })).toBe("pulse");
    expect(mcpToolName({ params: { name: "pulse" } })).toBe("pulse");
  });
  it("batch price = sum, aliases resolved", () => {
    expect(batchPaths({ calls: [{ path: "/v1/pulse" }, "/funding-rate?coin=BTC", { path: "x" }] })).toEqual(["/v1/pulse", "/funding-rate?coin=BTC"]);
    expect(batchPrice({ calls: [{ path: "/v1/pulse" }, { path: "/funding-rate?coin=BTC" }, { path: "/v1/options/BTC" }] })).toBeCloseTo(0.004, 6);
    expect(batchPrice({ calls: [{ path: "/v1/universe" }] })).toBe(0.001);
  });
  it("pick keeps dotted paths", () => {
    expect(pick({ a: 1, b: { c: 2, d: 3 }, e: 4 }, ["a", "b.c", "zz"])).toEqual({ a: 1, b: { c: 2 } });
    expect(pick({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
  it("types file", () => {
    const t = typesFile(toolCatalog(buildMcpServer()), "https://x", "v");
    expect(t).toContain("export interface DegenscanIntelTools"); expect(t).toContain("token_risk(args: { address: string; chain?: string })");
  });
  it("compact MCP over HTTP + batch + d.ts route", async () => {
    const app = await buildHttp(); const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const list = await app.inject({ method: "POST", url: "/mcp?mode=compact", headers: hdr, payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(parseSse(list.body).result.tools.map((x: any) => x.name).sort()).toEqual(["execute", "search"]);
    const se = await app.inject({ method: "POST", url: "/mcp?mode=compact", headers: hdr, payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search", arguments: { query: "universe assets" } } } });
    expect(parseSse(se.body).result.structuredContent.results.length).toBeGreaterThan(0);
    const ex = await app.inject({ method: "POST", url: "/mcp?mode=compact", headers: hdr, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "execute", arguments: { tool: "universe", arguments: {} } } } });
    expect(parseSse(ex.body).result.isError).toBeFalsy();
    const bad = await app.inject({ method: "POST", url: "/mcp?mode=compact", headers: hdr, payload: { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "execute", arguments: { tool: "nope" } } } });
    expect(parseSse(bad.body).result.isError).toBe(true);
    const b = await app.inject({ method: "POST", url: "/v1/batch", headers: { "x-free-trial": "1" }, payload: { calls: [{ path: "/v1/universe" }, { path: "/v1/sources" }] } });
    expect(b.statusCode).toBe(200); expect(b.json().n).toBe(2); expect(b.json().results.every((r: any) => r.status === 200)).toBe(true);
    expect((await app.inject({ method: "POST", url: "/v1/batch", payload: { calls: [{ path: "/v1/keys/me" }] } })).statusCode).toBe(400);
    const d = await app.inject({ method: "GET", url: "/sdk/degenscan-intel.d.ts" }); expect(d.statusCode).toBe(200); expect(d.body).toContain("pulse(");
    await app.close();
  });
});
