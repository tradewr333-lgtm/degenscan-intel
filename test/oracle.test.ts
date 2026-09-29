import { describe, it, expect, beforeAll } from "vitest";
process.env.DB_PATH = ":memory:";
process.env.INTEL_FREE = "1";
process.env.ORACLE_OPERATOR_KEY = "op-test-key";
process.env.ORACLE_CONCURRENCY = "2";

const { buildHttp } = await import("../src/server/http.js");
const llm = await import("../src/oracle/llm.js");
const ctx = await import("../src/oracle/context.js");
const engine = await import("../src/oracle/engine.js");
const ledger = await import("../src/oracle/ledger.js");
const queue = await import("../src/oracle/queue.js");

beforeAll(() => { llm._llm.chat = llm.mockChat(1); ctx._provider.current = ctx.mockProvider; });

describe("oracle context builder (port of context.py)", () => {
  it("parses asset/target/horizon and computes a volatility base rate", async () => {
    const c = await ctx.buildContext("Will Bitcoin close above 120,000 USD on 2026-10-31?", ctx.mockProvider, new Date(Date.UTC(2026, 8, 29)));
    expect(c.asset).toBe("BTC"); expect(c.target).toBe(120_000); expect(c.horizon_days).toBe(32);
    expect(Math.abs(c.distance_pct! - 9.59)).toBeLessThan(0.05);
    expect(c.base_rate!).toBeGreaterThan(0.05); expect(c.base_rate!).toBeLessThan(0.35); // ~+9.6% in 32d at 42% vol ≈ 1.7σ
    expect(c.base_rate).toBeCloseTo(0.227, 2); // same number the Python reference prints
    expect(c.sources).toEqual(expect.arrayContaining(["price_for", "derivs_for", "impact_for", "calendar"]));
    const c2 = await ctx.buildContext("Will the Fed cut at the October 2026 FOMC?", ctx.mockProvider);
    expect(c2.market_odds).toBe(0.71); expect(c2.asset).toBeNull();
  });
  it("ignores dates/years when detecting the target and complements the base rate for BELOW questions", async () => {
    expect(ctx.detectTarget("Will a new all-time high for Bitcoin be set between 2026-09-30 and 2026-10-31?")).toBeNull();
    expect(ctx.detectTarget("Will the Fed cut at the October 2026 FOMC?")).toBeNull();
    expect(ctx.detectTarget("Will BTC close above 91,500 USD on 2026-10-31?")).toBe(91_500);
    const above = await ctx.buildContext("Will BTC close above 100,000 USD on 2026-10-31?", ctx.mockProvider, new Date(Date.UTC(2026, 8, 29)));
    const below = await ctx.buildContext("Will BTC close below 100,000 USD on 2026-10-31?", ctx.mockProvider, new Date(Date.UTC(2026, 8, 29)));
    expect(above.base_rate! + below.base_rate!).toBeCloseTo(1, 2); expect(below.base_rate_note).toMatch(/complement/);
  });
  it("touch questions use the reflection principle (≈2× end-above)", () => {
    const [end] = ctx.baseRateThreshold(10, 0.5, 30, false); const [touch] = ctx.baseRateThreshold(10, 0.5, 30, true);
    expect(touch!).toBeCloseTo(Math.min(1, 2 * end!), 3);
  });
});

describe("oracle engine (port of engine.py, mock LLM)", () => {
  it("social question → hybrid, panel on, base rate injected, commitment hash, interventions noted", async () => {
    const f = await engine.forecast({ question: "Will BTC close above 120k on 2026-10-31?", runs: 4, population: 12, rounds: 3, context: "", interventions: [{ round: 2, news: "ETF outflows spike", audience: "half" }] }, { provider: ctx.mockProvider });
    expect(f.routing.method).toBe("hybrid"); expect(f.panel.length).toBe(5);
    expect(f.base_rate).not.toBeNull(); expect(f.context_used.spot).toBe(109_500);
    expect(f.probability).toBeGreaterThan(0); expect(f.probability).toBeLessThan(1);
    expect(Math.abs(f.probability - 0.5)).toBeGreaterThan(0.05); // not the coin-flip attractor
    expect(f.runs.length).toBe(4); expect(f.runs.every(r => r.belief_trajectory.length === 4)).toBe(true);
    expect(f.commitment_hash).toHaveLength(64);
    expect(f.runs[0].notes.some(n => n.includes("ETF outflows"))).toBe(true);
    expect(f.panel.every(e => "anchor" in e)).toBe(true);
    expect(f.cost.calls).toBeGreaterThan(10);
  });
  it("weather routes to expert panel, low confidence, no societies", async () => {
    llm._llm.chat = llm.mockChat(2);
    const f = await engine.forecast({ question: "Will it rain in Malaga on Oct 3?", runs: 2, population: 24, rounds: 3, context: "", interventions: [] }, { provider: ctx.mockProvider });
    expect(f.routing.method).toBe("expert_panel"); expect(f.confidence).toBe("low"); expect(f.panel.length).toBe(5); expect(f.runs.length).toBe(0);
    llm._llm.chat = llm.mockChat(1);
  });
  it("market odds → edge and market_brier in the ledger; track record aggregates", async () => {
    const f = await engine.forecast({ question: "Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?", runs: 2, population: 8, rounds: 2, context: "", interventions: [] }, { provider: ctx.mockProvider });
    expect(f.market_odds).toBe(0.71); expect(f.edge).not.toBeNull();
    ledger.putForecast(f);
    const r = ledger.resolveForecast(f.id, true)!;
    expect(r.brier).toBeCloseTo((f.probability - 1) ** 2, 4); expect(r.market_brier).toBeCloseTo((0.71 - 1) ** 2, 4);
    const tr = ledger.trackRecord();
    expect(tr.resolved).toBeGreaterThanOrEqual(1); expect(tr.vs_market.n).toBeGreaterThanOrEqual(1); expect(tr.vs_market.market_brier).toBeCloseTo(0.0841, 3);
  });
});

describe("oracle HTTP (async jobs, board, resolve, discovery)", () => {
  it("POST forecast → 202 → poll → done with full payload and billing; trial caps the config", async () => {
    const app = await buildHttp();
    const post = await app.inject({ method: "POST", url: "/v1/oracle/forecast", headers: { "x-free-trial": "1" }, payload: { question: "Will Bitcoin close above 120,000 USD on 2026-10-31?", resolves_at: "2026-10-31T23:59:00Z", runs: 8 } });
    expect(post.statusCode).toBe(202);
    const j = post.json(); expect(j.status).toBe("queued"); expect(j.forecast_id).toMatch(/^[0-9a-f]{12}$/); expect(j.eta_s).toBeGreaterThan(0); expect(j._billing.tool).toBe("oracle_forecast");
    expect(j.config.runs).toBeLessThanOrEqual(8);
    await queue.waitFor(j.forecast_id, 60_000);
    const got = await app.inject({ method: "GET", url: `/v1/oracle/forecast/${j.forecast_id}` });
    expect(got.statusCode).toBe(200); const f = got.json();
    expect(f.status).toBe("done");
    for (const k of ["probability", "ci80", "disagreement", "base_rate", "commitment_hash", "runs", "panel", "disclaimer", "context_used"]) expect(f).toHaveProperty(k);
    expect(f.context_used.sources.length).toBeGreaterThan(0); expect(f.runs[0].belief_trajectory.length).toBeGreaterThan(1); expect(f.panel[0]).toHaveProperty("anchor");
    expect(f.resolves_at).toBe("2026-10-31T23:59:00Z");
    // unknown id → 404; bad body → 400
    expect((await app.inject({ method: "GET", url: "/v1/oracle/forecast/nope00000000" })).statusCode).toBe(404);
    expect((await app.inject({ method: "POST", url: "/v1/oracle/forecast", payload: { question: "x" } })).statusCode).toBe(400);
    // resolve: operator key required, then Brier recorded and visible in the free track record
    expect((await app.inject({ method: "POST", url: `/v1/oracle/forecast/${j.forecast_id}/resolve`, payload: { outcome: false } })).statusCode).toBe(401);
    const res = await app.inject({ method: "POST", url: `/v1/oracle/forecast/${j.forecast_id}/resolve`, headers: { "x-operator-key": "op-test-key" }, payload: { outcome: false } });
    expect(res.statusCode).toBe(200); expect(res.json().brier).toBeCloseTo(f.probability ** 2, 4);
    const tr = await app.inject({ method: "GET", url: "/v1/oracle/track-record" });
    expect(tr.json().resolved).toBeGreaterThanOrEqual(1); expect(tr.json().recent[0]).toHaveProperty("commitment_hash");
  });
  it("board serves the latest forecast per slug from the DB (no LLM) and bills oracle_board", async () => {
    const app = await buildHttp();
    const f = await engine.forecast({ question: "Will Bitcoin close above 120,000 USD on 2026-10-31?", runs: 1, population: 8, rounds: 1, context: "", interventions: [] }, { provider: ctx.mockProvider });
    ledger.putForecast(f, "btc-120k-oct31");
    const b = await app.inject({ method: "GET", url: "/v1/oracle/board" });
    expect(b.statusCode).toBe(200); expect(b.json().items.map((i: any) => i.slug)).toContain("btc-120k-oct31"); expect(b.json()._billing.tool).toBe("oracle_board");
    const one = await app.inject({ method: "GET", url: "/v1/oracle/board/btc-120k-oct31" });
    expect(one.statusCode).toBe(200); expect(one.json().probability).toBe(f.probability); expect(one.json().history.length).toBeGreaterThanOrEqual(1);
    expect((await app.inject({ method: "GET", url: "/v1/oracle/board/nope" })).statusCode).toBe(404);
  });
  it("discovery lists the oracle tools with prices; openapi has the routes; MCP registers 4 oracle tools", async () => {
    const app = await buildHttp();
    const wk = (await app.inject({ method: "GET", url: "/.well-known/x402" })).json();
    const tools = wk.resources.map((r: any) => r.tool);
    expect(tools).toEqual(expect.arrayContaining(["oracle_forecast", "oracle_board"]));
    expect(wk.resources.find((r: any) => r.tool === "oracle_forecast").price_usd).toBe(0.25);
    expect(wk.resources.find((r: any) => r.tool === "oracle_board").price_usd).toBe(0.002);
    const oa = (await app.inject({ method: "GET", url: "/openapi.json" })).json();
    expect(oa.paths["/v1/oracle/forecast"].post["x-price-usd"]).toBe(0.25); expect(oa.paths["/v1/oracle/track-record"]).toBeDefined();
    const { buildMcpServer } = await import("../src/server/mcp.js");
    const s: any = buildMcpServer();
    const names = Object.keys(s._registeredTools ?? {});
    expect(names).toEqual(expect.arrayContaining(["oracle_forecast", "oracle_get", "oracle_board", "oracle_track_record"]));
    expect(names.length).toBe(22);
  });
});

describe("oracle board (scheduler logic, mocked sources)", () => {
  it("refreshBoard forecasts Lote 1 + Polymarket questions once per day, board serves them with resolution rules, autoResolve settles closed markets", async () => {
    const board = await import("../src/oracle/board.js");
    const tools = await import("../src/server/tools.js");
    tools._ext.reset(); tools._hl.reset();
    tools._hl.post = (async () => { throw new Error("offline"); }) as any;   // no dynamic ±10/20% questions without a spot
    tools._ext.get = (async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets?active=true")) return [{ id: "9", slug: "fed-cut-october-2026", question: "Will the Fed cut rates in October 2026?", outcomePrices: '["0.62","0.38"]', volume24hr: 5e6, liquidity: 1e6, endDate: "2026-10-29T00:00:00Z" }];
      if (url.includes("gamma-api.polymarket.com/markets?slug=fed-cut-october-2026")) return [{ slug: "fed-cut-october-2026", closed: true, outcomePrices: '["1","0"]' }];
      throw new Error("unexpected url " + url);
    }) as any;
    const qs = await board.boardQuestions();
    expect(qs.map(q => q.slug)).toEqual(expect.arrayContaining(["btc-120k-oct31", "fed-cut-oct2026", "pm-fed-cut-october-2026"]));
    const r1: any = await board.refreshBoard({ runs: 1, population: 8, rounds: 1 });
    expect(r1.queued + r1.skipped.length).toBe(qs.length); expect(r1.queued).toBeGreaterThanOrEqual(qs.length - 1); // btc-120k-oct31 was already forecast today by the earlier test
    const r2: any = await board.refreshBoard({ runs: 1, population: 8, rounds: 1 });   // same day → nothing new
    expect(r2.queued).toBe(0); expect(r2.skipped.length).toBe(qs.length);
    const app = await buildHttp();
    const b = (await app.inject({ method: "GET", url: "/v1/oracle/board" })).json();
    expect(b.count).toBeGreaterThanOrEqual(qs.length);
    const pm = b.items.find((i: any) => i.slug === "pm-fed-cut-october-2026");
    expect(pm.resolution.type).toBe("polymarket"); expect(pm.probability).toBeGreaterThan(0);
    const res = await board.autoResolve();
    expect(res.resolved.map(r => r.slug)).toContain("pm-fed-cut-october-2026"); expect(res.resolved.find(r => r.slug === "pm-fed-cut-october-2026")!.outcome).toBe(true);
    const tr = (await app.inject({ method: "GET", url: "/v1/oracle/track-record" })).json();
    expect(tr.vs_market.n).toBeGreaterThanOrEqual(0); expect(tr.resolved).toBeGreaterThanOrEqual(1);
    // operator endpoints gated; questions list free
    expect((await app.inject({ method: "POST", url: "/v1/oracle/board/refresh", payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/v1/oracle/board/questions" })).json().items.length).toBe(qs.length);
    tools._ext.reset(); tools._hl.reset();
  });
});
