import { describe, it, expect, beforeAll } from "vitest";
process.env.DB_PATH = ":memory:";
process.env.INTEL_FREE = "1";
import { buildHttp } from "../src/server/http.js";
import { scoreEvent } from "../src/engine/impact.js";
import { upsertEvent, queryEvents, impactsForAsset } from "../src/store/db.js";

const SRC = { id: "test", name: "Test", tier: "primary" as const };

beforeAll(() => {
  const now = new Date();
  upsertEvent(scoreEvent({ native_id: "a", ts_event: now.toISOString(), source: SRC, kind: "reg.enforcement", title: "SEC charges Coinbase over staking program", summary: "", entities: [{ type: "regulator", id: "regulator:SEC", name: "SEC", confidence: 1 }], severity: 0.7, novelty: 0.8, raw_ref: "x" }, now));
  upsertEvent(scoreEvent({ native_id: "b", ts_event: new Date(now.getTime() - 3_600_000).toISOString(), source: SRC, kind: "nat.quake", title: "M7.1 earthquake — Tainan, Taiwan", summary: "", geo: { lat: 23.1, lng: 120.3, radius_km: 200 }, severity: 0.75, novelty: 0.8, raw_ref: "x" }, now));
  // corroborating media item with same fingerprint from another source → should not create a new event
  upsertEvent(scoreEvent({ native_id: "c", ts_event: now.toISOString(), source: { id: "media1", name: "Media", tier: "media" }, kind: "media.report", title: "SEC charges Coinbase over staking program", summary: "", severity: 0.2, novelty: 0.3, raw_ref: "y" }, now));
});

describe("store", () => {
  it("dedupes by fingerprint across sources and bumps corroboration", () => {
    const evs = queryEvents({ since: new Date(Date.now() - 86_400_000).toISOString() });
    expect(evs).toHaveLength(2);
    const sec = evs.find(e => e.kind === "reg.enforcement")!;
    expect(sec.corroboration.count).toBe(2);
    expect(sec.corroboration.sources).toContain("media1");
  });
  it("filters by asset and kind prefix", () => {
    expect(queryEvents({ since: new Date(Date.now() - 86_400_000).toISOString(), assets: ["COIN"] })).toHaveLength(1);
    expect(queryEvents({ since: new Date(Date.now() - 86_400_000).toISOString(), kinds: ["nat."] })).toHaveLength(1);
    expect(queryEvents({ since: new Date(Date.now() - 86_400_000).toISOString(), q: "earthquake" })).toHaveLength(1);
  });
  it("impact_for aggregates direction", () => {
    const r = impactsForAsset("COIN", new Date(Date.now() - 86_400_000).toISOString());
    expect(r.n_events).toBe(1);
    expect(r.bias).toBe(-1);
  });
});

describe("http + mcp", () => {
  let app: Awaited<ReturnType<typeof buildHttp>>;
  beforeAll(async () => { app = await buildHttp(); });
  it("REST /v1/events returns scored events with billing info", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/events?since=24h&universe=TSM,NVDA" });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.count).toBe(1);
    expect(b.events[0].impacts.find((i: any) => i.asset_id === "NVDA").direction).toBe(-1);
    expect(b._billing.method).toBe("free");
  });
  it("REST /v1/regime works", async () => {
    const r = await app.inject({ method: "GET", url: "/v1/regime" });
    expect(r.statusCode).toBe(200);
    expect(r.json().events_24h).toBe(2);
    expect(r.json().venues_open).toHaveProperty("crypto", true);
  });
  it("MCP initialize + tools/list + tools/call over streamable HTTP", async () => {
    const hdr = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const init = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } } });
    expect(init.statusCode).toBe(200);
    const list = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 2, method: "tools/list" } });
    const names = parseSse(list.body).result.tools.map((t: any) => t.name);
    expect(names).toEqual(expect.arrayContaining(["events_since", "impact_for", "exposure_graph", "regime_snapshot", "universe", "sources_status", "explain"]));
    const call = await app.inject({ method: "POST", url: "/mcp", headers: hdr, payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "impact_for", arguments: { asset_id: "coin", since: "24h" } } } });
    const res = parseSse(call.body).result;
    expect(res.structuredContent.asset.id).toBe("COIN");
    expect(res.structuredContent.n_events).toBe(1);
  });
});

function parseSse(body: string) {
  const line = body.split("\n").find(l => l.startsWith("data:"));
  return JSON.parse(line ? line.slice(5) : body);
}
