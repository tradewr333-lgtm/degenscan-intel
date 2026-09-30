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
    // generic "cut" question vs two sibling cut-size markets → YES prices summed; a "25 bps" question keeps the single market
    const sibs = [{ question: "Will the Fed decrease interest rates by 50 bps after the October 2026 meeting?", yes: 0.0025, url: "s50" }, { question: "Will the Fed decrease interest rates by 25 bps after the October 2026 meeting?", yes: 0.0065, url: "s25" }, { question: "Will the Fed increase interest rates by 25 bps after the October 2026 meeting?", yes: 0.01, url: "h25" }];
    const sum = ctx.matchMarket("Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?", sibs);
    expect(sum?.yes).toBeCloseTo(0.009, 4); expect(sum?.url).toBe("s25");
    expect(ctx.matchMarket("Will the Fed cut by 25 bps at the October 2026 FOMC meeting?", sibs)?.url).toBe("s25");
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
    expect(tr.json()).toHaveProperty("n_pending"); expect(tr.json()).toHaveProperty("next_resolves_at"); expect(tr.json().edge_vs_base_by_version["0.3.3-ts"]).toBeDefined(); expect(tr.json().edge_vs_base_by_version["0.3.3-ts"]).toHaveProperty("frac_positive"); expect(tr.json()).toHaveProperty("first_resolution");
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
    expect(names.length).toBe(24);
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
      if (url.includes("query1.finance.yahoo.com")) throw new Error("yahoo blocked in test → stooq fallback");
      if (url.includes("stooq.com")) { expect(init?.text).toBe(true); return csv; }
      if (url.includes("coinlore.net/api/global")) return [{ total_mcap: 2.9e12, mcap_change: "-1.2", btc_d: "57.1" }];
      throw new Error("unexpected " + url);
    }) as any;
    tools._hl.post = (async (body: any) => {
      if (body.type === "metaAndAssetCtxs") return [{ universe: [{ name: "SOL" }, { name: "ETH" }, { name: "BTC" }] }, [{ funding: "0", openInterest: "1", prevDayPx: "100", dayNtlVlm: "1", premium: "0", oraclePx: "100", markPx: "100", midPx: "100" }, { funding: "0", openInterest: "1", prevDayPx: "3000", dayNtlVlm: "1", premium: "0", oraclePx: "3000", markPx: "3000", midPx: "3000" }, { funding: "0", openInterest: "1", prevDayPx: "83000", dayNtlVlm: "1", premium: "0", oraclePx: "83000", markPx: "83000", midPx: "83000" }]];
      if (body.type === "candleSnapshot") { const amp = body.req.coin === "SOL" ? 0.04 : 0.02; let px = 100; return Array.from({ length: 33 }, (_, i) => { px *= i % 2 ? 1 + amp : 1 - amp; return { t: now - (32 - i) * 86_400_000, T: now - (31 - i) * 86_400_000, c: String(px) }; }); }
      throw new Error("unexpected " + body.type);
    }) as any;
    const copom = await sources.extraFactsFor("Will Brazil's central bank (Copom) cut the Selic rate at its November 2026 meeting?", { asset: null, horizon_days: 37 });
    expect(copom.facts.selic_target_pct).toBe(15); expect(copom.market_odds).toBe(0.85); expect(copom.sources).toContain("selic_focus"); expect((copom.facts.provider as any).selic_focus).toMatch(/bcb/);
    const spx = await sources.extraFactsFor("Will the S&P 500 close October 2026 above its September 2026 close?", { asset: "SPX", horizon_days: 31 });
    expect(spx.facts.spx_close).toBeGreaterThan(6000); expect(spx.base_rate).toBeGreaterThan(0.2); expect(spx.base_rate).toBeLessThan(0.8);
    const mcap = await sources.extraFactsFor("Will total crypto market cap be higher on 2026-10-31 than on 2026-09-30 (CoinGecko)?", { asset: null, horizon_days: 31 });
    expect(mcap.facts.total_crypto_mcap_usd).toBe(2.9e12); expect(mcap.facts.mcap_source).toBe("coinlore"); expect(mcap.base_rate).toBeCloseTo(0.5, 2);
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

describe("polymarketSearch pulls the whole event for sibling summing", () => {
  it("Fed cut question: top-50 has only the 50 bps market; the event adds the 25 bps one → summed odds", async () => {
    const tools = await import("../src/server/tools.js");
    tools._ext.reset();
    const ev = { title: "Fed Decision in October?", markets: [
      { question: "Will the Fed decrease interest rates by 50+ bps after the October 2026 meeting?", outcomePrices: '["0.0025","0.9975"]', active: true, closed: false, slug: "fed-dec-50" },
      { question: "Will the Fed decrease interest rates by 25 bps after the October 2026 meeting?", outcomePrices: '["0.0045","0.9955"]', active: true, closed: false, slug: "fed-dec-25" },
      { question: "Will there be no change in Fed interest rates after the October 2026 meeting?", outcomePrices: '["0.555","0.445"]', active: true, closed: false, slug: "fed-hold" },
      { question: "Will the Fed increase interest rates by 25 bps after the October 2026 meeting?", outcomePrices: '["0.435","0.565"]', active: true, closed: false, slug: "fed-inc-25" },
    ] };
    tools._ext.get = (async (url: string) => {
      if (url.includes("gamma-api.polymarket.com/markets?active=true")) return [{ id: "1", slug: "fed-dec-50", question: ev.markets[0].question, outcomePrices: ev.markets[0].outcomePrices, volume24hr: 1e6, liquidity: 1e5, endDate: "2026-10-29T00:00:00Z" }, { id: "2", slug: "fed-hold", question: ev.markets[2].question, outcomePrices: ev.markets[2].outcomePrices, volume24hr: 9e6, liquidity: 1e6, endDate: "2026-10-29T00:00:00Z" }];
      if (url.includes("gamma-api.polymarket.com/markets?slug=fed-dec-50")) return [{ slug: "fed-dec-50", events: [{ slug: "fed-decision-in-october" }] }];
      if (url.includes("gamma-api.polymarket.com/events?slug=fed-decision-in-october")) return [ev];
      throw new Error("unexpected " + url);
    }) as any;
    const m: any = await ctx.intelProvider.polymarketSearch("Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?");
    expect(m.yes).toBeCloseTo(0.007, 4); expect(m.event).toBe("Fed Decision in October?"); expect(m.question).toMatch(/2 sibling outcomes/);
    tools._ext.reset();
  });
});

describe("v0.10.5 — tail-bias fix and automatic resolvers", () => {
  it("log-odds mean matches the Architect's case", () => {
    expect(Math.abs(engine.logitMean([0.02, 0.03, 0.15]) - 0.04)).toBeLessThan(0.01);
    expect(engine.logitMean([0.5, 0.5])).toBeCloseTo(0.5, 6);
  });
  it("resolves Coinbase daily close, touch via daily highs, SPX month, rvol, Selic cut, Fed event-any — and legacy Lote-1 rows by question text", async () => {
    const tools = await import("../src/server/tools.js");
    const sources = await import("../src/oracle/sources.js");
    const board = await import("../src/oracle/board.js");
    const { getDb } = await import("../src/store/db.js");
    tools._ext.reset(); tools._hl.reset(); sources._sources.reset();
    const d = getDb(); ledger.ensureOracleTables();
    d.exec("CREATE TABLE IF NOT EXISTS oracle_board (slug TEXT PRIMARY KEY, question TEXT NOT NULL, resolves_at TEXT NOT NULL, resolution TEXT NOT NULL, source TEXT, updated_at TEXT NOT NULL)");
    const past = "2026-09-01T23:59:59Z";
    const mk = (slug: string, q: string, rule: any, boardSlug: string | null = slug, resolves = past) => {
      d.prepare("INSERT OR REPLACE INTO oracle_board (slug, question, resolves_at, resolution, source, updated_at) VALUES (?,?,?,?,?,?)").run(slug, q, resolves, JSON.stringify(rule), null, new Date().toISOString());
      const f: any = { id: "t-" + slug + (boardSlug ? "" : "-legacy"), question: q, created_at: "2026-08-20T00:00:00Z", resolves_at: resolves, routing: { domain: "t", method: "hybrid", human_driven: true, binary: true, rationale: "" }, probability: 0.3, ci80: [0.2, 0.4], disagreement: 0, runs: [], panel: [], summary: "", drivers: [], failure_modes: [], confidence: "medium", cost: {}, commitment_hash: "x", market_odds: null, market_ref: null, edge: null, base_rate: 0.3, edge_vs_base: 0, config: { runs: 1, population: 1, rounds: 1, capped: false }, context_used: {}, engine_version: "test", disclaimer: "" };
      ledger.putForecast(f, boardSlug);
      return f.id;
    };
    const ids = {
      close: mk("t-close", "T close above 100?", { type: "price_close_above", symbol: "BTC", target: 100 }),
      touch: mk("t-touch", "T touch 150?", { type: "price_touch_above", symbol: "BTC", target: 150 }, "t-touch", "2027-01-01T00:00:00Z"),
      touchLo: mk("t-touchlo", "T touch below 50?", { type: "price_touch_below", symbol: "BTC", target: 50 }, "t-touchlo", "2027-01-01T00:00:00Z"),
      spx: mk("t-spx", "T spx?", { type: "spx_month_above_prev", month: "2026-08" }),
      rvol: mk("t-rvol", "T rvol?", { type: "rvol_above", a: "SOL", b: "ETH", date: "2026-09-01" }),
      selic: mk("t-selic", "T selic?", { type: "selic_cut", meeting_date: "2026-08-15" }),
      fed: mk("t-fed", "T fed?", { type: "polymarket_event_any", event_slug: "ev", match: "decrease" }),
    };
    const legacyId = mk("t-close2", "T legacy close above 100?", { type: "price_close_above", symbol: "BTC", target: 100 }, null);
    tools._ext.get = (async (url: string) => {
      if (url.includes("api.exchange.coinbase.com")) return [[Date.parse("2026-09-01T00:00:00Z") / 1000, 90, 130, 95, 120, 1]];
      if (url.includes("query1.finance.yahoo.com")) { const ts: number[] = [], cl: number[] = []; for (let i = 0; i < 60; i++) { const t = Date.parse("2026-07-10T20:00:00Z") + i * 86_400_000; ts.push(t / 1000); cl.push(new Date(t).toISOString().slice(0, 7) === "2026-08" ? 6600 : 6500); } return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ close: cl }] } }] } }; }
      if (url.includes("bcdata.sgs.432")) return [{ data: "10/08/2026", valor: "15,00" }, { data: "18/08/2026", valor: "14,75" }];
      if (url.includes("events?slug=ev")) return [{ markets: [{ question: "Will the Fed decrease rates by 25 bps?", closed: true, outcomePrices: '["1","0"]' }, { question: "Will the Fed decrease rates by 50 bps?", closed: true, outcomePrices: '["0","1"]' }] }];
      throw new Error("unexpected " + url);
    }) as any;
    tools._hl.post = (async (body: any) => {
      if (body.type === "candleSnapshot") {
        const coin = body.req.coin; const amp = coin === "SOL" ? 0.05 : 0.01; let px = 100; const out: any[] = []; const end = body.req.endTime;
        for (let i = 35; i >= 0; i--) { px *= i % 2 ? 1 + amp : 1 - amp; out.push({ t: end - (i + 1) * 86_400_000, T: end - i * 86_400_000, c: String(px), h: String(coin === "BTC" ? (i === 3 ? 160 : 120) : px), l: String(coin === "BTC" ? (i === 5 ? 40 : 110) : px) }); }
        return out;
      }
      throw new Error("unexpected " + body.type);
    }) as any;
    const res = await board.autoResolve();
    const got = Object.fromEntries(res.resolved.map(r => [r.id, r.outcome]));
    expect(got[ids.close]).toBe(true);   // Coinbase close 120 > 100
    expect(got[ids.touch]).toBe(true);   // a daily high of 160 ≥ 150
    expect(got[ids.touchLo]).toBe(true); // a daily low of 40 ≤ 50 (touch below uses lows)
    expect(ledger.getForecast(ids.close)!.resolution_note).toBeUndefined(); // official Coinbase candle → no fallback note
    expect(got[ids.spx]).toBe(true);     // Aug last close 6600 > Jul last close 6500
    expect(got[ids.rvol]).toBe(true);    // SOL swings 5 %/day vs ETH 1 %
    expect(got[ids.selic]).toBe(true);   // 15.00 → 14.75
    expect(got[ids.fed]).toBe(true);     // the 25 bps "decrease" market resolved YES
    expect(got[legacyId]).toBe(true);    // legacy row resolved with the board rule sharing its question text
    tools._ext.reset(); tools._hl.reset(); sources._sources.reset();
  });
});

describe("empirical rvol persistence (Architect §4.2)", () => {
  it("SOL always more volatile than ETH → persistence 1 with ≥ 60 overlapping samples; used as base rate", async () => {
    const tools = await import("../src/server/tools.js");
    const sources = await import("../src/oracle/sources.js");
    tools._hl.reset(); sources._sources.reset();
    tools._hl.post = (async (body: any) => {
      if (body.type === "candleSnapshot") { const amp = body.req.coin === "SOL" ? 0.05 : 0.02; const n = Math.floor((body.req.endTime - body.req.startTime) / 86_400_000); let px = 100; const out: any[] = []; for (let i = 0; i < n; i++) { px *= i % 2 ? 1 + amp * (1 + (i % 3) / 10) : 1 - amp; out.push({ t: body.req.startTime + i * 86_400_000, T: body.req.startTime + (i + 1) * 86_400_000, c: String(px) }); } return out; }
      if (body.type === "metaAndAssetCtxs") return [{ universe: [{ name: "SOL" }, { name: "ETH" }] }, [{ funding: "0", openInterest: "1", prevDayPx: "100", dayNtlVlm: "1", premium: "0", oraclePx: "100", markPx: "100", midPx: "100" }, { funding: "0", openInterest: "1", prevDayPx: "3000", dayNtlVlm: "1", premium: "0", oraclePx: "3000", markPx: "3000", midPx: "3000" }]];
      throw new Error("unexpected " + body.type);
    }) as any;
    tools._ext.get = (async () => { throw new Error("no coinbase in this test"); }) as any;
    const per = await sources.rvolPersistence("SOL", "ETH", 31);
    expect(per.h_days).toBe(30); expect((await sources.rvolPersistence("SOL", "ETH", 33)).h_days).toBe(35); // cache/horizon rounded to 5 d
    expect(per.n).toBeGreaterThanOrEqual(60); expect(per.persistence).toBeCloseTo((per.n + 1) / (per.n + 2), 3);
    const x = await sources.extraFactsFor("Will Solana close above Ethereum in 30-day realized volatility on 2026-10-31?", { asset: "SOL", horizon_days: 31 });
    expect((x.facts as any).rvol_persistence_n).toBe(per.n);
    expect(x.base_rate).toBe(per.persistence); expect(x.base_rate!).toBeLessThan(1); expect(x.base_rate_note).toMatch(/measured persistence/);
    tools._hl.reset(); tools._ext.reset(); sources._sources.reset();
  });
});

describe("token_verdict (GoPlus + DexScreener, mocked)", () => {
  it("honeypot → DANGER; clean liquid token → LOW_RISK; bad input → 400", async () => {
    const tools = await import("../src/server/tools.js");
    const tv = await import("../src/server/token-verdict.js");
    tools._ext.reset(); tv._tv.reset();
    const bad = "0x1111111111111111111111111111111111111111", good = "0x2222222222222222222222222222222222222222";
    tools._ext.get = (async (url: string) => {
      if (url.includes("gopluslabs") && url.includes(bad)) return { code: 1, result: { [bad]: { token_symbol: "SCAM", is_honeypot: "1", sell_tax: "0.99", buy_tax: "0", is_open_source: "0", is_mintable: "1", holder_count: "40", holders: [{ address: "0xa", percent: "0.8", is_contract: 0, is_locked: 0 }], lp_holders: [{ address: "0xb", percent: "1", is_locked: 0 }] } } };
      if (url.includes("gopluslabs") && url.includes(good)) return { code: 1, result: { [good]: { token_symbol: "GOOD", is_honeypot: "0", sell_tax: "0", buy_tax: "0", is_open_source: "1", is_mintable: "0", owner_address: "", holder_count: "50000", holders: [{ address: "0xc", percent: "0.05", is_contract: 0, is_locked: 0 }], lp_holders: [{ address: "0x000000000000000000000000000000000000dead", percent: "0.9", is_locked: 1 }], is_in_cex: { listed: "1" } } } };
      if (url.includes("dexscreener")) return { pairs: [{ chainId: "base", dexId: "uniswap", pairAddress: "0xp", url: "https://dexscreener.com/base/0xp", liquidity: { usd: url.includes(good) ? 2_000_000 : 3_000 }, volume: { h24: 100_000 }, priceUsd: "1.0", fdv: 1e8, pairCreatedAt: Date.now() - 400 * 86_400_000, baseToken: { symbol: "X", name: "X" } }] };
      throw new Error("unexpected " + url);
    }) as any;
    const b = await tv.tokenVerdict({ address: bad });
    expect(b.verdict).toBe("DANGER"); expect(b.flags.map((f: any) => f.id)).toEqual(expect.arrayContaining(["honeypot", "sell_tax_extreme", "not_verified", "thin_liquidity"]));
    const g = await tv.tokenVerdict({ address: good, chain: "base" });
    expect(g.verdict).toBe("LOW_RISK"); expect(g.score).toBeGreaterThanOrEqual(80); expect(g.market?.liquidity_usd).toBe(2_000_000);
    await expect(tv.tokenVerdict({ address: "nope" })).rejects.toThrow(/invalid address/);
    tools._ext.reset(); tv._tv.reset();
  });
});

describe("A2A JSON-RPC (message/send → tool)", () => {
  it("agent card declares JSONRPC at /a2a; message/send runs a skill on the free trial; unknown → input-required", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const card = (await app.inject({ method: "GET", url: "/.well-known/agent-card.json" })).json();
    expect(card.preferredTransport).toBe("JSONRPC"); expect(card.url).toMatch(/\/a2a$/);
    const r = (await app.inject({ method: "POST", url: "/a2a", headers: { "content-type": "application/json", "x-free-trial": "1" }, payload: { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", messageId: "m1", parts: [{ kind: "data", data: { skill: "oracle_track_record", input: {} } }] } } } })).json();
    expect(r.result.status.state).toBe("completed"); expect(r.result.artifacts[0].parts[0].data).toHaveProperty("n_pending");
    const h = (await app.inject({ method: "POST", url: "/a2a", payload: { jsonrpc: "2.0", id: 2, method: "message/send", params: { message: { parts: [{ kind: "text", text: "hello" }] } } } })).json();
    expect(h.result.status.state).toBe("input-required");
    await app.close();
  });
});

describe("matchMarket guards (bug 30/09: wrong-asset / wrong-level matches from board data)", () => {
  it("S&P question never matches a Bitcoin market; a 120k target never matches 85k/87.5k 'reach' markets nor sums them", async () => {
    const { matchMarket } = await import("../src/oracle/context.js");
    const mk = [
      { question: "Will Bitcoin reach $85k in September 2026?", yes: 0.12, url: "a" },
      { question: "Will Bitcoin reach $87.5k in September 2026?", yes: 0.07, url: "b" },
      { question: "Will Bitcoin reach $87pt5k in September 2026?", yes: 0.05, url: "c" },
    ];
    expect(matchMarket("Will the S&P 500 close October 2026 above its September 2026 close?", mk)).toBeNull();
    expect(matchMarket("Will Bitcoin close above 120,000 USD on 2026-10-31 (Coinbase daily close, UTC)?", mk)).toBeNull();
    expect(matchMarket("Will Bitcoin close below 73,500 USD on 2026-10-31 (Coinbase daily close, UTC)?", mk)).toBeNull();
    const ok = matchMarket("Will Bitcoin reach 120,000 USD in October 2026?", [...mk, { question: "Will Bitcoin reach $120k in October 2026?", yes: 0.03, url: "d" }]);
    expect(ok?.url).toBe("d"); expect(ok?.yes).toBe(0.03);
  });
});

describe("measurement exclusions + polymarket_edge + /oracle page", () => {
  it("operator-paid and match-bug rows leave the metrics but stay in the ledger; edge list sorts by |p − odds| and skips excluded rows", async () => {
    const { getDb } = await import("../src/store/db.js");
    const routes = await import("../src/server/oracle-routes.js");
    ledger.ensureOracleTables(); const d = getDb();
    const base: any = { question: "Q", resolves_at: "2027-01-01T00:00:00Z", routing: { domain: "t", method: "hybrid", human_driven: true, binary: true, rationale: "" }, ci80: [0.1, 0.9], disagreement: 0, runs: [], panel: [], summary: "", drivers: [], failure_modes: [], confidence: "medium", cost: {}, commitment_hash: "h", market_ref: "https://polymarket.com/market/x", edge: null, config: { runs: 1, population: 1, rounds: 1, capped: false }, context_used: {}, engine_version: "0.3.3-ts", disclaimer: "" };
    const put = (id: string, slug: string, p: number, odds: number, created = new Date().toISOString(), bb = 0.3) => ledger.putForecast({ ...base, id, question: "Q " + slug, created_at: created, probability: p, market_odds: odds, base_rate: bb, edge_vs_base: p - bb }, slug);
    put("e-big", "edge-big", 0.60, 0.40); put("e-small", "edge-small", 0.50, 0.48);
    put("e-bug", "btc-120k-oct31", 0.04, 0.243, "2026-09-30T06:10:00Z", 0.001);
    d.prepare("INSERT INTO oracle_jobs (id, status, request, payer, created_at, board_slug) VALUES (?,?,?,?,?,?)").run("e-op", "done", "{}", "0x5344722b8d037827a9a5b7cd6312481d215d33bf", new Date().toISOString(), null);
    ledger.putForecast({ ...base, id: "e-op", created_at: new Date().toISOString(), probability: 0.06, market_odds: null, base_rate: 0.067, edge_vs_base: -0.007 }, null);
    const tr: any = ledger.trackRecord();
    expect(tr.measurement_excluded.operator_wallet).toBeGreaterThanOrEqual(1);
    expect(tr.measurement_excluded["market_match_bug_v0.10.8"]).toBeGreaterThanOrEqual(1);
    expect(ledger.getForecast("e-op")).not.toBeNull();   // still in the ledger
    const e = routes.polymarketEdge(0, 50);
    const slugs = e.items.map((x: any) => x.slug);
    expect(slugs).not.toContain("btc-120k-oct31");
    expect(slugs.indexOf("edge-big")).toBeLessThan(slugs.indexOf("edge-small"));
    const app = await buildHttp();
    const page = await app.inject({ method: "GET", url: "/oracle" });
    expect(page.statusCode).toBe(200); expect(page.body).toMatch(/public board/);
    const unpaid = await app.inject({ method: "GET", url: "/v1/oracle/edge" });
    expect([200, 402]).toContain(unpaid.statusCode);
    await app.close();
  });
});

describe("Oracle Edge paper bot", () => {
  it("opens one position per market above the edge threshold, marks and settles from Gamma, reports P&L", async () => {
    const tools = await import("../src/server/tools.js");
    const bot = await import("../src/bot/paper.js");
    tools._ext.reset();
    const items = [
      { slug: "s1", question: "Q1", probability: 0.60, market_odds: 0.40, edge: 0.20, market_ref: "https://polymarket.com/market/m-one", forecast_id: "f1", commitment_hash: "h1" },
      { slug: "s2", question: "Q2", probability: 0.30, market_odds: 0.50, edge: -0.20, market_ref: "https://polymarket.com/market/m-two", forecast_id: "f2", commitment_hash: "h2" },
      { slug: "s3", question: "Q3", probability: 0.51, market_odds: 0.50, edge: 0.01, market_ref: "https://polymarket.com/market/m-three", forecast_id: "f3", commitment_hash: "h3" },
    ];
    const o1 = await bot.openPositions(items); const o2 = await bot.openPositions(items);
    expect(o1.map((o: any) => o.slug)).toEqual(["s1", "s2"]); expect(o2).toHaveLength(0);   // below-threshold skipped, never re-entered
    tools._ext.get = (async (url: string) => {
      if (url.includes("m-one")) return [{ closed: true, outcomePrices: '["1","0"]' }];   // YES won → our YES pays 1
      if (url.includes("m-two")) return [{ closed: false, outcomePrices: '["0.45","0.55"]' }];  // NO now 0.55
      throw new Error("unexpected " + url);
    }) as any;
    await bot.markAndSettle();
    const r: any = bot.botReport();
    const p1 = r.positions.find((p: any) => p.board_slug === "s1"), p2 = r.positions.find((p: any) => p.board_slug === "s2");
    expect(p1.status).toBe("settled"); expect(p1.pnl).toBeGreaterThan(0);
    expect(p2.side).toBe("NO"); expect(p2.mark_price).toBeCloseTo(0.55, 5);
    expect(r.summary.positions).toBe(2); expect(r.paper).toBe(true);
    tools._ext.reset();
  });
});

describe("/bot page", () => {
  it("renders a friendly page in PT by default and EN on request", async () => {
    const app = await buildHttp();
    const pt = await app.inject({ method: "GET", url: "/bot" }); const en = await app.inject({ method: "GET", url: "/bot?lang=en" });
    expect(pt.statusCode).toBe(200); expect(pt.body).toMatch(/SIMULAÇÃO/); expect(en.body).toMatch(/PAPER/);
    await app.close();
  });
});

describe("Lote Eventos (Brazil election, 30/09)", () => {
  it("board carries the curated election questions with pinned Polymarket markets", async () => {
    const board = await import("../src/oracle/board.js");
    const ctx = await import("../src/oracle/context.js");
    const qs = board.eventQuestions();
    expect(qs.map(q => q.slug)).toEqual(expect.arrayContaining(["br-1t-outright-2026", "br-1t-lula-most-votes-2026", "br-president-lula-2026", "br-president-flavio-2026"]));
    for (const q of qs) { expect(q.resolution.type).toBe("polymarket"); expect(ctx.PINNED_MARKETS.get(q.question)).toBe((q.resolution as any).slug); expect(ctx.detectTarget(q.question)).toBeNull(); }
    const tools = await import("../src/server/tools.js");
    const prev = tools._ext.get;
    tools._ext.get = (async (url: string) => { if (url.includes("markets?slug=will-lula-win-the-most-votes")) return [{ slug: "x", question: "q", outcomePrices: '["0.71","0.29"]' }]; throw new Error("unexpected " + url); }) as any;
    const r = await ctx.intelProvider.polymarketSearch("Will Lula win the most votes in the first round of the 2026 Brazil presidential election?");
    expect(r?.yes).toBeCloseTo(0.71); expect(r?.url).toContain("will-lula-win-the-most-votes");
    tools._ext.get = prev;
  });
});

describe("/previsoes page (30/09)", () => {
  it("renders prediction cards in Portuguese and English", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const pt = await app.inject({ method: "GET", url: "/previsoes" });
    expect(pt.statusCode).toBe(200); expect(pt.body).toContain("Previsões do Oráculo"); expect(pt.body).toContain('class="card"');
    expect(pt.body).toContain("não é recomendação de investimento");
    const en = await app.inject({ method: "GET", url: "/predictions" });
    expect(en.statusCode).toBe(200); expect(en.body).toContain("Oracle predictions");
    const { categoryOf } = await import("../src/server/predictions-page.js");
    expect(categoryOf("br-president-lula-2026", "Will Lula win the 2026 Brazilian presidential election?")).toBe("eleicoes");
    expect(categoryOf("fed-cut-oct2026", "Will the US Federal Reserve cut the federal funds rate at its October 2026 FOMC meeting?")).toBe("juros");
    expect(categoryOf("btc-above-1-202610", "Will BTC close above 90,000 USD on 2026-10-31?")).toBe("cripto");
  });
});

describe("/app human product (30/09)", () => {
  it("serves app, help and pricing pages; /v1/me needs a key and reports forecasts left", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const keys = await import("../src/server/keys.js");
    const app = await buildHttp();
    for (const [u, t] of [["/app", "Pergunte ao Oráculo"], ["/app?lang=en", "Ask the Oracle"], ["/ajuda", "Ajuda"], ["/help", "Help"], ["/pricing", "Planos"], ["/pricing?lang=en", "Pricing"]]) {
      const r = await app.inject({ method: "GET", url: u }); expect(r.statusCode).toBe(200); expect(r.body).toContain(t);
    }
    expect((await app.inject({ method: "GET", url: "/pricing" })).body).not.toMatch(/token verdict/i);
    expect((await app.inject({ method: "GET", url: "/v1/me" })).statusCode).toBe(401);
    const { key } = keys.createKey({ plan: "hobby", label: "test" });
    const me = (await app.inject({ method: "GET", url: "/v1/me", headers: { "x-api-key": key } })).json();
    expect(me.plan).toBe("hobby"); expect(me.forecasts_left).toBe(16); expect(me.credits_per_forecast).toBe(125);
    const h = (await app.inject({ method: "GET", url: "/v1/me/forecasts", headers: { "x-api-key": key } })).json();
    expect(Array.isArray(h.items)).toBe(true);
  });
});
