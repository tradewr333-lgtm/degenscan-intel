import { describe, it, expect, beforeAll } from "vitest";
process.env.DB_PATH = ":memory:";
process.env.INTEL_FREE = "1";
const { buildHttp } = await import("../src/server/http.js");
const { scoreEvent } = await import("../src/engine/impact.js");
const { upsertEvent, queryEvents, impactsForAsset } = await import("../src/store/db.js");

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
    expect(names).toEqual(expect.arrayContaining(["events_since", "impact_for", "exposure_graph", "regime_snapshot", "universe", "sources_status", "explain", "polymarket_context", "pulse", "news_for", "filings_for", "calendar", "brief"]));
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

describe("agent-facing docs", () => {
  it("serves the skill and advertises prepaid packs", async () => {
    const app = await buildHttp();
    const sk = await app.inject({ method: "GET", url: "/skill.md" });
    expect(sk.statusCode).toBe(200); expect(sk.body).toContain("name: degenscan-intel"); expect(sk.body).toContain("pack_1k");
    const packs = await app.inject({ method: "GET", url: "/v1/keys/packs" });
    expect(packs.json().packs.pack_1k).toMatchObject({ usd: 5, calls: 1000 });
    const root = await app.inject({ method: "GET", url: "/" });
    expect(root.json().skill).toContain("/skill.md");
    expect(root.json().version).toBe("0.10.23");
    const wk = await app.inject({ method: "GET", url: "/.well-known/x402" }); expect(wk.json().resources.length).toBeGreaterThan(5);
    const oa = await app.inject({ method: "GET", url: "/openapi.json" }); expect(oa.json().openapi).toBe("3.1.0");
    const wl = await app.inject({ method: "GET", url: "/wallets.json" }); expect(wl.json().owned_or_test_wallets.length).toBe(2);
  });
});

describe("polymarket_context", () => {
  it("falls back to feed search when Gamma is unreachable and returns related primary events", async () => {
    const { questionTerms, polymarketContext } = await import("../src/server/tools.js");
    expect(questionTerms("Will the SEC charge Coinbase over staking by year end?")).toEqual(expect.arrayContaining(["sec", "coinbase", "staking"]));
    const r = await polymarketContext({ market: "Will the SEC charge Coinbase over staking?", since: "24h", limit: 10 });
    expect(r.n_related).toBeGreaterThanOrEqual(1);
    expect(r.related[0].title).toContain("Coinbase");
    expect(r.related[0].tier).toBe("primary");
    expect(r.related[0].impacts.find((i: any) => i.asset_id === "COIN")?.direction).toBe(-1);
    const app = await buildHttp();
    const rest = await app.inject({ method: "GET", url: "/v1/polymarket/" + encodeURIComponent("SEC Coinbase staking") + "?since=24h" });
    expect(rest.statusCode).toBe(200);
    expect(rest.json()._billing.tool).toBe("polymarket_context");
  });
});

describe("v0.5 endpoints", () => {
  it("pulse, news, filings, calendar, brief work on the seeded store and are billed per tool", async () => {
    const app = await buildHttp();
    const p = await app.inject({ method: "GET", url: "/v1/pulse" });
    expect(p.statusCode).toBe(200); expect(p.json().by_class.reg).toBe(1); expect(p.json()._billing.tool).toBe("pulse");
    const n = await app.inject({ method: "GET", url: "/v1/news/COIN?since=24h" });
    expect(n.statusCode).toBe(200); expect(n.json()._billing.tool).toBe("news_for");
    const f = await app.inject({ method: "GET", url: "/v1/filings/COIN?since=7d" });
    expect(f.statusCode).toBe(200); expect(f.json().asset.id).toBe("COIN");
    const c = await app.inject({ method: "GET", url: "/v1/calendar?days=60&types=macro,fomc" });
    expect(c.statusCode).toBe(200); expect(c.json().items.some((i: any) => i.subtype === "fomc")).toBe(true);
    const b = await app.inject({ method: "GET", url: "/v1/brief/COIN" });
    expect(b.statusCode).toBe(200); const bj = b.json();
    expect(bj.pressure.bias).toBe(-1); expect(bj.headlines).toBeTruthy(); expect(bj.upcoming_catalysts).toBeInstanceOf(Array); expect(bj._billing.price_usd).toBe(0);
    const wk = await app.inject({ method: "GET", url: "/.well-known/x402" });
    expect(wk.json().resources.map((r: any) => r.tool)).toEqual(expect.arrayContaining(["pulse", "brief", "calendar", "news_for", "filings_for"]));
  });
});

describe("derivs_for (Hyperliquid, mocked)", () => {
  it("maps metaAndAssetCtxs + predictedFundings into funding/OI/premium with flags and billing", async () => {
    const tools = await import("../src/server/tools.js");
    tools._hl.reset();
    tools._hl.post = (async (body: any) => {
      if (body.type === "metaAndAssetCtxs") return [
        { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "HYPE", szDecimals: 2, maxLeverage: 5 }] },
        [{ funding: "0.0000125", openInterest: "25000", prevDayPx: "64000", dayNtlVlm: "2000000000", premium: "0.0003", oraclePx: "65000", markPx: "65010", midPx: "65005" },
         { funding: "0.0008", openInterest: "9000000", prevDayPx: "30", dayNtlVlm: "50000000", premium: "0.004", oraclePx: "31", markPx: "31.2", midPx: "31.1" }],
      ];
      if (body.type === "predictedFundings") return [["BTC", [["BinPerp", { fundingRate: "0.0001", nextFundingTime: 1800000000000 }], ["HlPerp", { fundingRate: "0.0000125", nextFundingTime: 1800000000000 }], ["BybitPerp", null]]]];
      throw new Error("unexpected " + body.type);
    }) as any;
    const app = await buildHttp();
    const b = await app.inject({ method: "GET", url: "/v1/derivs/btc" });
    expect(b.statusCode).toBe(200); const j = b.json();
    expect(j.symbol).toBe("BTC"); expect(j._billing.tool).toBe("derivs_for");
    expect(j.funding.rate_1h).toBeCloseTo(0.0000125, 9); expect(j.funding.annualized_pct).toBeCloseTo(10.95, 1);
    expect(j.open_interest.usd).toBe(Math.round(25000 * 65010)); expect(j.price.change_24h_pct).toBeCloseTo(1.578, 2);
    expect(j.funding.predicted_by_venue.map((p: any) => p.venue)).toEqual(["BinPerp", "HlPerp"]);
    expect(j.flags).toEqual([]);
    const h = await app.inject({ method: "GET", url: "/v1/derivs/HYPE-PERP" });
    expect(h.statusCode).toBe(200); expect(h.json().flags).toEqual(expect.arrayContaining(["funding_hot_long", "premium_rich", "oi_heavy_vs_volume"]));
    const x = await app.inject({ method: "GET", url: "/v1/derivs/NOPE" });
    expect(x.statusCode).toBe(404);
    const wk = await app.inject({ method: "GET", url: "/.well-known/x402" });
    expect(wk.json().resources.map((r: any) => r.tool)).toContain("derivs_for");
    tools._hl.reset();
  });
});

describe("docs for LLMs", () => {
  it("serves /docs index, every page, llms-full.txt, sitemap and robots", async () => {
    const app = await buildHttp();
    const idx = await app.inject({ method: "GET", url: "/docs" });
    expect(idx.statusCode).toBe(200); expect(idx.body).toContain("funding-rate-open-interest-api-without-api-key");
    const pg = await app.inject({ method: "GET", url: "/docs/how-ai-agents-pay-per-api-call-with-usdc-x402" });
    expect(pg.statusCode).toBe(200); expect(pg.body).toContain("PAYMENT-REQUIRED"); expect(pg.body).toContain("npm i @degenscan/intel"); expect(pg.body).toContain("FAQPage");
    const full = await app.inject({ method: "GET", url: "/llms-full.txt" });
    expect(full.statusCode).toBe(200); expect(full.body).toContain("derivs_for: 0.003"); expect(full.body.split("## ").length).toBeGreaterThan(9);
    const sm = await app.inject({ method: "GET", url: "/sitemap.xml" }); expect(sm.body).toContain("/docs/pre-trade-brief-api-one-call");
    const rb = await app.inject({ method: "GET", url: "/robots.txt" }); expect(rb.body).toContain("Sitemap:");
  });
});

describe("v0.8 entry shelf (mocked public sources)", () => {
  it("price_for, funding_alerts, whale_moves, polymarket_top respond and bill per tool", async () => {
    const tools = await import("../src/server/tools.js");
    tools._ext.reset(); tools._hl.reset();
    tools._hl.post = (async (body: any) => {
      if (body.type === "metaAndAssetCtxs") return [
        { universe: [{ name: "BTC", szDecimals: 5, maxLeverage: 40 }, { name: "HYPE", szDecimals: 2, maxLeverage: 5 }, { name: "DOGE", szDecimals: 0, maxLeverage: 10 }] },
        [{ funding: "0.0000125", openInterest: "25000", prevDayPx: "64000", dayNtlVlm: "2000000000", premium: "0.0003", oraclePx: "65000", markPx: "65010", midPx: "65005" },
         { funding: "0.0008", openInterest: "9000000", prevDayPx: "30", dayNtlVlm: "50000000", premium: "0.004", oraclePx: "31", markPx: "31.2", midPx: "31.1" },
         { funding: "-0.0005", openInterest: "100000000", prevDayPx: "0.2", dayNtlVlm: "90000000", premium: "-0.001", oraclePx: "0.2", markPx: "0.199", midPx: "0.199" }],
      ];
      if (body.type === "predictedFundings") return [["HYPE", [["HlPerp", { fundingRate: "0.0008", nextFundingTime: 1800000000000 }], ["BinPerp", null]]]];
      if (body.type === "candleSnapshot") {
        // 32 daily closes alternating ±2% → daily log-return stdev ≈ 0.0202, annualised ≈ 0.386; last candle still open (T in the future) must be dropped
        const now = Date.now(); const out: any[] = []; let px = 60000;
        for (let i = 32; i >= 0; i--) { px = px * (i % 2 ? 1.02 : 0.98); out.push({ t: now - i * 86_400_000, T: now - (i - 1) * 86_400_000, c: String(px) }); }
        return out;
      }
      throw new Error("unexpected " + body.type);
    }) as any;
    tools._ext.get = (async (url: string) => {
      if (url.includes("api.coinbase.com")) return { data: { amount: "64990.00", currency: "USD" } };
      if (url.includes("blockscout.com")) return { items: [
        { total: { value: "25000000000000" }, from: { hash: "0xabc" }, to: { hash: "0xA9D1e08C7793af67e9d92fe308d5697FB81d3E43" }, transaction_hash: "0xtx1", timestamp: "2026-09-29T00:00:00Z" },
        { total: { value: "500000000" }, from: { hash: "0xdef" }, to: { hash: "0x123" }, transaction_hash: "0xtx2" },
        { total: { value: "3000000000000" }, from: { hash: "0x0000000000000000000000000000000000000000" }, to: { hash: "0x456" }, transaction_hash: "0xtx3" },
      ] };
      if (url.includes("gamma-api.polymarket.com/markets?active=true")) return [
        { id: "1", slug: "fed-cut-october", question: "Fed rate cut in October?", outcomePrices: '["0.62","0.38"]', oneDayPriceChange: 0.03, volume24hr: 1250000.4, liquidity: 500000, endDate: "2026-10-29T00:00:00Z" },
      ];
      throw new Error("unexpected url " + url);
    }) as any;
    const app = await buildHttp();
    const p = await app.inject({ method: "GET", url: "/v1/price/btc" });
    expect(p.statusCode).toBe(200); const pj = p.json();
    expect(pj.perp.mark).toBe(65010); expect(pj.spot.price).toBe(64990); expect(pj.basis_pct).toBeCloseTo(0.0308, 3); expect(pj._billing.tool).toBe("price_for");
    expect(pj.realized_vol_30d_ann).toBeGreaterThan(0.36); expect(pj.realized_vol_30d_ann).toBeLessThan(0.41); expect(pj.realized_vol_note).toMatch(/30 daily log-returns/);
    const h = await app.inject({ method: "GET", url: "/health" }); expect(h.json().storage).toEqual({ path: expect.any(String), persistent: false }); expect(typeof h.json().calls).toBe("number");
    const f = await app.inject({ method: "GET", url: "/v1/funding/alerts?min_abs_rate_1h=0.0003" });
    expect(f.statusCode).toBe(200); const fj = f.json();
    expect(fj.alerts.map((x: any) => x.symbol)).toEqual(["HYPE", "DOGE"]); expect(fj.alerts[0].side_paying).toBe("longs"); expect(fj.alerts[1].side_paying).toBe("shorts");
    expect(fj.alerts[0].predicted_by_venue).toEqual([{ venue: "HlPerp", rate: 0.0008 }]); expect(fj._billing.tool).toBe("funding_alerts");
    const w = await app.inject({ method: "GET", url: "/v1/whales?min_usd=1000000&chains=ethereum" });
    expect(w.statusCode).toBe(200); const wj = w.json();
    expect(wj.count).toBe(4); expect(wj.moves[0].usd).toBe(25000000); expect(wj.moves[0].to_label).toBe("Coinbase 10"); expect(wj.moves[0].flow).toBe("to_exchange");
    expect(wj.moves.some((m: any) => m.flow === "mint")).toBe(true); expect(wj.totals_usd.to_exchange).toBe(50000000); expect(wj._billing.tool).toBe("whale_moves");
    const t = await app.inject({ method: "GET", url: "/v1/polymarket/top?sort=volume_24h&limit=5" });
    expect(t.statusCode).toBe(200); const tj = t.json();
    expect(tj.markets[0].yes_prob).toBe(0.62); expect(tj.markets[0].volume_24h_usd).toBe(1250000); expect(tj.markets[0].evidence).toBe("/v1/polymarket/fed-cut-october?since=48h"); expect(tj._billing.tool).toBe("polymarket_top");
    // /v1/polymarket/top must be priced as polymarket_top ($0.002) in the x402 manifest, not as the wildcard ($0.01)
    const wk0 = await app.inject({ method: "GET", url: "/.well-known/x402" });
    const top = wk0.json().resources.find((r: any) => r.tool === "polymarket_top");
    expect(top?.price_usd ?? top?.price).toBe(0.002);
    const wk = await app.inject({ method: "GET", url: "/.well-known/x402" });
    expect(wk.json().resources.map((r: any) => r.tool)).toEqual(expect.arrayContaining(["price_for", "funding_alerts", "whale_moves", "polymarket_top"]));
    tools._ext.reset(); tools._hl.reset();
  });
});
