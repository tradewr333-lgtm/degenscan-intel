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
    expect(ctx.detectTarget("Will SOL close below 95 USD on 2026-10-31?")).toBe(95);
    expect(ctx.detectTarget("Will BTC drop 15% before 2026-10-31?")).toBeNull();
    const above = await ctx.buildContext("Will BTC close above 100,000 USD on 2026-10-31?", ctx.mockProvider, new Date(Date.UTC(2026, 8, 29)));
    const below = await ctx.buildContext("Will BTC close below 100,000 USD on 2026-10-31?", ctx.mockProvider, new Date(Date.UTC(2026, 8, 29)));
    expect(above.base_rate! + below.base_rate!).toBeCloseTo(1, 2); expect(below.base_rate_note).toMatch(/complement/);
  });
  it("v0.3.1 parity: detect_target cases, touch-below reflection, match_market with synonyms/event tag/direction", async () => {
    expect(ctx.detectTarget("Will BTC trade above 95k before 2026-10-31?")).toBe(95_000);
    expect(ctx.detectTarget("Will SOL close below $ 95 on 2026-10-31?")).toBe(95);
    expect(ctx.detectTarget("Will 95 people attend?")).toBeNull();
    expect(ctx.detectDirection("Will Bitcoin close below 75,000 USD?")).toBe("below");
    const now = new Date(Date.UTC(2026, 8, 29));
    const cb = await ctx.buildContext("Will Bitcoin close below 75,000 USD on 2026-10-31?", ctx.mockProvider, now);
    expect(cb.base_rate!).toBeLessThan(0.15); expect(cb.base_rate_note.startsWith("complement")).toBe(true);
    const tb = await ctx.buildContext("Will Bitcoin trade below 75,000 USD at any point before 2026-10-31?", ctx.mockProvider, now);
    expect(tb.base_rate!).toBeCloseTo(Math.min(1, 2 * cb.base_rate!), 2);
    const markets = [
      { question: "Will the Fed decrease interest rates by 25 bps after the October meeting?", yes: 0.36, url: "u1" },
      { question: "Will the Fed increase interest rates by 25 bps after the October meeting?", yes: 0.01, url: "u2" },
      { question: "Will Bitcoin hit $100k in October?", yes: 0.12, url: "u3" },
      { question: "Will Lakers win the 2026 NBA finals?", yes: 0.08, url: "u4" },
    ];
    const m = ctx.matchMarket("Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?", markets);
    expect(m?.url).toBe("u1");
    expect(ctx.matchMarket("Will Brazil's Copom cut the Selic in November 2026?", markets)).toBeNull();
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
    for (const k of ["probability", "ci80", "disagreement", "base_rate", "commitment_hash", "runs", "panel", "disclaimer", "context_used", "edge_vs_base", "engine_version"]) expect(f).toHaveProperty(k);
    expect(f.config.capped).toBe(true); expect(f.config.runs).toBe(2);
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
    expect(tr.json()).toHaveProperty("n_pending"); expect(tr.json()).toHaveProperty("next_resolves_at"); expect(tr.json().edge_vs_base_by_version["0.3.1-ts"]).toBeDefined();
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

describe("oracle extra sources (Selic/Focus, SPX, market cap, SOL vs ETH vol) — mocked", () => {
  it("grounds the four manual Lote-1 questions with facts, synthetic odds and base rates", async () => {
    const tools = await import("../src/server/tools.js");
    const sources = await import("../src/oracle/sources.js");
    tools._ext.reset(); tools._hl.reset(); sources._sources.reset();
    const now = Date.now(); const csv = ["Date,Open,High,Low,Close,Volume", ...Array.from({ length: 45 }, (_, i) => { const d = new Date(now - (45 - i) * 86_400_000).toISOString().slice(0, 10); const c = 6500 * (1 + 0.01 * Math.sin(i * 7.3)); return `${d},${c},${c},${c},${c.toFixed(2)},1`; })].join("\n");
    tools._ext.get = (async (url: string, init: any) => {
      if (url.includes("bcdata.sgs.432")) return [{ data: "29/09/2026", valor: "15,00" }];
      if (url.includes("ExpectativasMercadoSelic")) return { value: [{ Data: "2026-09-26", Reuniao: "R7/2026", Mediana: 14.75, Minimo: 14.5, Maximo: 15.0, numeroRespondentes: 80 }, { Data: "2026-09-26", Reuniao: "R8/2026", Mediana: 14.5, Minimo: 14.25, Maximo: 15.0, numeroRespondentes: 78 }] };
      if (url.includes("stooq.com")) { expect(init?.text).toBe(true); return csv; }
      if (url.includes("coingecko.com/api/v3/global")) return { data: { total_market_cap: { usd: 2.9e12 }, market_cap_change_percentage_24h_usd: -1.2, market_cap_percentage: { btc: 57.1 } } };
      if (url.includes("market_chart")) return { market_caps: Array.from({ length: 32 }, (_, i) => [now - (31 - i) * 86_400_000, 1.65e12 * (1 + 0.01 * Math.sin(i))]) };
      throw new Error("unexpected " + url);
    }) as any;
    tools._hl.post = (async (body: any) => {
      if (body.type === "metaAndAssetCtxs") return [{ universe: [{ name: "SOL" }, { name: "ETH" }] }, [{ funding: "0", openInterest: "1", prevDayPx: "100", dayNtlVlm: "1", premium: "0", oraclePx: "100", markPx: "100", midPx: "100" }, { funding: "0", openInterest: "1", prevDayPx: "3000", dayNtlVlm: "1", premium: "0", oraclePx: "3000", markPx: "3000", midPx: "3000" }]];
      if (body.type === "candleSnapshot") { const amp = body.req.coin === "SOL" ? 0.04 : 0.02; let px = 100; return Array.from({ length: 33 }, (_, i) => { px *= i % 2 ? 1 + amp : 1 - amp; return { t: now - (32 - i) * 86_400_000, T: now - (31 - i) * 86_400_000, c: String(px) }; }); }
      throw new Error("unexpected " + body.type);
    }) as any;
    const copom = await sources.extraFactsFor("Will Brazil's central bank (Copom) cut the Selic rate at its November 2026 meeting?", { asset: null, horizon_days: 37 });
    expect(copom.facts.selic_target_pct).toBe(15); expect(copom.market_odds).toBe(0.85); expect(copom.sources).toContain("bcb_sgs_focus");
    const spx = await sources.extraFactsFor("Will the S&P 500 close October 2026 above its September 2026 close?", { asset: "SPX", horizon_days: 31 });
    expect(spx.facts.spx_close).toBeGreaterThan(6000); expect(spx.base_rate).toBeGreaterThan(0.2); expect(spx.base_rate).toBeLessThan(0.8);
    const mcap = await sources.extraFactsFor("Will total crypto market cap be higher on 2026-10-31 than on 2026-09-30 (CoinGecko)?", { asset: null, horizon_days: 31 });
    expect(mcap.facts.total_crypto_mcap_usd).toBe(2.9e12); expect(mcap.base_rate).not.toBeNull();
    const rvol = await sources.extraFactsFor("Will Solana close above Ethereum in 30-day realized volatility on 2026-10-31?", { asset: "SOL", horizon_days: 31 });
    expect(rvol.facts.sol_realized_vol_30d_ann).toBeGreaterThan(rvol.facts.eth_realized_vol_30d_ann as number); expect(rvol.base_rate).toBe(0.78);
    // through buildContext with the real provider wiring (extra facts hook)
    const c = await ctx.buildContext("Will Brazil's central bank (Copom) cut the Selic rate at its November 2026 meeting?", ctx.intelProvider);
    expect(c.market_odds).toBe(0.85); expect(c.extra.selic_target_pct).toBe(15);
    tools._ext.reset(); tools._hl.reset(); sources._sources.reset();
  });
});

describe("Push D — legacy import", () => {
  it("imports Lote-1 rows preserving id/hash/created_at, verifies the hash, labels the engine version, refuses duplicates", async () => {
    const app = await buildHttp();
    const { createHash } = await import("node:crypto");
    const created = "2026-09-29T10:00:00+00:00"; const p = 0.52; const id = "abc123def456";
    const hash = createHash("sha256").update(`${id}|Will X happen?|${p.toFixed(4)}|${created}`).digest("hex");
    const row = { id, question: "Will X happen?", created_at: created, resolves_at: "2026-10-31T00:00:00Z", probability: p, commitment_hash: hash, domain: "crypto", method: "hybrid", payload: JSON.stringify({ ci80: [0.4, 0.6], confidence: "low", routing: { domain: "crypto", method: "hybrid", human_driven: true, binary: true, rationale: "" } }) };
    expect((await app.inject({ method: "POST", url: "/v1/admin/oracle/import", payload: { rows: [row] } })).statusCode).toBe(401);
    const r = await app.inject({ method: "POST", url: "/v1/admin/oracle/import", headers: { "x-operator-key": "op-test-key" }, payload: { rows: [row] } });
    expect(r.json().imported).toBe(1); expect(r.json().results[0].hash_verified).toBe(true);
    const g = (await app.inject({ method: "GET", url: `/v1/oracle/forecast/${id}` })).json();
    expect(g.engine_version).toBe("0.2-nodata"); expect(g.commitment_hash).toBe(hash); expect(g.created_at).toBe(created); expect(g.probability).toBe(p);
    const again = await app.inject({ method: "POST", url: "/v1/admin/oracle/import", headers: { "x-operator-key": "op-test-key" }, payload: { rows: [row] } });
    expect(again.json().results[0].status).toBe("exists");
    const tr = (await app.inject({ method: "GET", url: "/v1/oracle/track-record" })).json();
    expect(tr.forecasts_total).toBeGreaterThanOrEqual(1);
  });
});
