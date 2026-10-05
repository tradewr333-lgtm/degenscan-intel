process.env.DB_PATH = ":memory:";
import { describe, it, expect, beforeAll, vi } from "vitest";

describe("Carry Oracle data layer (Hyperliquid funding, all dexes)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      const json = (x: any) => ({ ok: true, json: async () => x });
      if (b.type === "perpDexs") return json([null, { name: "xyz" }, { name: "io" }]);
      if (b.type === "metaAndAssetCtxs") {
        if (!b.dex) return json([{ universe: [{ name: "BTC" }, { name: "OLD", isDelisted: true }] }, [{ funding: "0.0000125", markPx: "60000", openInterest: "10", dayNtlVlm: "5000000" }, {}]]);
        const f = b.dex === "xyz" ? "0.00004" : "0.00001";
        return json([{ universe: [{ name: `${b.dex}:NBIS` }] }, [{ funding: f, markPx: b.dex === "xyz" ? "100" : "100.5", openInterest: "1000", dayNtlVlm: "2000000" }]]);
      }
      if (b.type === "spotMetaAndAssetCtxs") return json([{ universe: [{ name: "@1", tokens: [1, 0] }], tokens: [{ index: 0, name: "USDC" }, { index: 1, name: "UBTC" }] }, [{ coin: "@1", markPx: "59990", dayNtlVlm: "1000000" }]]);
      if (b.type === "candleSnapshot") { const n = 340, now = Date.now(); const base = b.req.coin.includes("NBIS") ? 100 : 60000;
        return json(Array.from({ length: n }, (_, i) => ({ t: now - (n - i) * 3600e3, c: String(base * (1 + 0.01 * Math.sin(i / 5)) * (b.req.coin.startsWith("io:") ? 1.001 : 1)) }))); }
      if (b.type === "l2Book") return json({ levels: [[{ px: "99.99", sz: "5000" }, { px: "99.9", sz: "5000" }], [{ px: "100.01", sz: "5000" }, { px: "100.1", sz: "5000" }]] });
      if (b.type === "fundingHistory") return json([{ coin: b.coin, fundingRate: "0.00002", premium: "0", time: Date.now() - 5 * 3600e3 }, { coin: b.coin, fundingRate: "0.00003", premium: "0", time: Date.now() - 4 * 3600e3 }]);
      return json(null);
    });
  });
  it("snapshots every dex, skips delisted, maps spot base, backfills history and computes cross-dex spreads", async () => {
    const c = await import("../src/carry/hl.js");
    const { getDb } = await import("../src/store/db.js");
    c.ensureCarryTables(); getDb().exec("DELETE FROM hl_funding; DELETE FROM hl_spot; DELETE FROM hl_backfill;");
    const coins = await c.snapshot();
    expect(coins.sort()).toEqual(["BTC", "io:NBIS", "xyz:NBIS"]);
    await c.backfillMissing(coins, 0);
    const st = c.carryStats();
    expect(st.funding.coins).toBe(3); expect(st.funding.dexes).toBe(3); expect(st.backfill.rows).toBe(6);
    const m = c.fundingMatrix();
    const btc = m.items.find((i: any) => i.coin === "BTC")!;
    expect(btc.funding_apr).toBeCloseTo(0.1095, 3); expect(btc.spot?.mark).toBe(59990);
    const x = c.crossDex();
    expect(x.items[0].base).toBe("NBIS");
    expect(x.items[0].legs[0].dex).toBe("xyz");
    expect(x.items[0].spread_apr_now).toBeCloseTo((0.00004 - 0.00001) * 8760, 3);
    expect(c.coinHistory("xyz:NBIS").hours).toBe(3);
    expect(x.items.every((i: any) => i.legs.every((l: any) => l.dex !== "main"))).toBe(true);
    const sp = c.spotPerp({ minVol: 0 });
    expect(sp.items[0].base).toBe("BTC"); expect(sp.items[0].spot_mark).toBe(59990);
    await c.backfillMissing(coins, 0);           // second pass: nothing to do
    expect(c.carryStats().backfill.rows).toBe(6);
  });
});

describe("Carry Oracle toll: flat US$100/month, no metering", () => {
  it("carry routes need a live carry key; stats and /carry stay open; other keys are refused", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const k = await import("../src/server/keys.js");
    const app = await buildHttp();
    expect((await app.inject({ url: "/v1/carry/stats" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/carry" })).body).toContain("US$ 100/mês");
    const r = await app.inject({ url: "/v1/carry/xdex" });
    expect(r.statusCode).toBe(402); expect(r.json().error).toBe("carry_subscription_required"); expect(r.json().price).toContain("100");
    const hobby = k.createKey({ plan: "hobby" });
    expect((await app.inject({ url: "/v1/carry/xdex", headers: { "x-api-key": hobby.key } })).statusCode).toBe(402);
    const c = k.createCarryKey({ via: "stripe", stripe_subscription: "sub_test_carry" });
    const ok = await app.inject({ url: "/v1/carry/funding-matrix", headers: { "x-api-key": c.key } });
    expect(ok.statusCode).toBe(200);
    for (let i = 0; i < 5; i++) expect((await app.inject({ url: "/v1/carry/xdex", headers: { "x-api-key": c.key } })).statusCode).toBe(200);
    k.revokeBySubscription("sub_test_carry");
    expect((await app.inject({ url: "/v1/carry/xdex", headers: { "x-api-key": c.key } })).statusCode).toBe(402);
    const u = k.createCarryKey({ via: "x402", wallet: "0xabc" });   // pending until settlement
    expect(k.carryAccess(u.key).ok).toBe(false);
    k.activatePackKey(u.id, "0xtx"); expect(k.carryAccess(u.key).ok).toBe(true);
    // a carry key has no budget on the metered tools
    expect(k.validateKey(c.key)?.remaining ?? 0).toBe(0);
  });
});

describe("Carry Lote A: naked, watchdog, waitlist, docs, discovery", () => {
  it("naked lists unhedgeable extremes; watchdog reports markets incl. delisted; both gated", async () => {
    const c = await import("../src/carry/hl.js");
    const { getDb } = await import("../src/store/db.js");
    c.ensureCarryTables(); getDb().exec("DELETE FROM hl_funding; DELETE FROM hl_spot; DELETE FROM hl_backfill; DELETE FROM hl_markets;");
    await c.snapshot();
    const n = c.naked({ minAbsApr: 0.1 });            // xyz:NBIS 0.00004*8760 = 35 % but it has an io pair → excluded; BTC has spot → excluded
    expect(n.items.find((i: any) => i.coin === "xyz:NBIS")).toBeUndefined();
    expect(n.items.find((i: any) => i.coin === "BTC")).toBeUndefined();
    const w = c.watchdog();
    expect(w.markets.find((m: any) => m.coin === "OLD")?.status).toBe("delisted");
    expect(w.dexes.find((d: any) => d.dex === "main")?.markets).toBe(2);
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    expect((await app.inject({ url: "/v1/carry/naked" })).statusCode).toBe(402);
    expect((await app.inject({ url: "/v1/carry/watchdog" })).statusCode).toBe(402);
  });
  it("waitlist stores a contact (dedup by email), rejects bad email, honeypot silently ignored", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const { getDb } = await import("../src/store/db.js");
    const app = await buildHttp();
    const post = (b: any) => app.inject({ method: "POST", url: "/v1/carry/waitlist", payload: b });
    expect((await post({ email: "bad" })).statusCode).toBe(400);
    expect((await post({ email: "a@fund.xyz", profile: "fund", tier_interest: "desk", lang: "en" })).statusCode).toBe(201);
    expect((await post({ email: "A@fund.xyz", profile: "vault" })).statusCode).toBe(201);
    expect((await post({ email: "bot@spam.xyz", website: "http://x" })).statusCode).toBe(201);
    const rows = getDb().prepare("SELECT email, profile FROM carry_waitlist").all() as any[];
    expect(rows.filter(r => r.email === "a@fund.xyz")).toHaveLength(1);
    expect(rows.find(r => r.email === "bot@spam.xyz")).toBeUndefined();
    expect((await app.inject({ url: "/v1/admin/carry/waitlist" })).statusCode).toBe(401);
  });
  it("docs page, llms.txt, stats tiers and MCP carry tools expose the product", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const docs = await app.inject({ url: "/docs/carry" });
    expect(docs.statusCode).toBe(200); expect(docs.body).toContain("Field dictionary"); expect(docs.body).toContain("/v1/carry/xdex");
    expect((await app.inject({ url: "/llms.txt" })).body).toContain("/v1/carry/funding-matrix");
    expect((await app.inject({ url: "/v1/carry/stats" })).json().tiers[0].name).toBe("Carry Data");
    expect((await app.inject({ url: "/carry" })).body).toContain("Lista de espera do Carry Desk");
    const { buildMcpServer } = await import("../src/server/mcp.js");
    const s: any = buildMcpServer({});
    const tool = s._registeredTools?.carry_xdex;
    expect(tool).toBeTruthy();
    const r = await tool.handler({}, {});
    expect(JSON.parse(r.content[0].text).error).toBe("subscription_required");
  });
});


describe("Carry Desk (Lote B): eligibility, capacity, realized, after-hours, alerts, gating", () => {
  it("computes the desk analytics on the stored data", async () => {
    const c = await import("../src/carry/hl.js");
    const { getDb } = await import("../src/store/db.js");
    c.ensureCarryTables(); getDb().exec("DELETE FROM hl_funding; DELETE FROM hl_spot; DELETE FROM hl_backfill; DELETE FROM hl_markets;");
    const coins = await c.snapshot(); await c.backfillMissing(coins, 0);
    const d = await import("../src/carry/desk.js");
    const el = await d.eligible({ min_liq: 0 }, { minVol: 0 });
    const x = el.items.find((i: any) => i.kind === "xdex");
    expect(x.legs[0].coin).toBe("xyz:NBIS"); expect(x.legs[0].side).toBe("short");
    expect(x.checks.corr_1h_14d.value).toBeGreaterThan(0.99);
    expect(x.checks).toHaveProperty("breakeven_days_taker");
    expect(el.items.some((i: any) => i.kind === "spot_perp")).toBe(true);
    const cap = await d.capacity({ capital: 100000, lev: 3, maxPairs: 2 });
    expect(cap.items[0].legs[0].depth_bps20_usd).toBeGreaterThan(0);
    expect(cap.allocation.capital_usd).toBe(100000);
    const r = await d.realized(x.pair_key);
    expect(r.windows.map((w: any) => w.hours)).toEqual([168, 336, 720]);
    expect(r.windows[0].fees_pct).toBeCloseTo(0.18, 5);
    const ah = await d.afterhours();
    expect(Array.isArray(ah.items)).toBe(true);
    const close = d.lastUsClose(new Date("2026-10-03T12:00:00Z"));           // Saturday → Friday 02/10 16:00 ET = 20:00 UTC
    expect(close.toISOString()).toBe("2026-10-02T20:00:00.000Z");
  });
  it("desk routes need a desk key; a data key gets 403; alerts are created signed and listed", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const k = await import("../src/server/keys.js");
    const app = await buildHttp();
    expect((await app.inject({ url: "/v1/carry/eligible" })).statusCode).toBe(402);
    const data = k.createCarryKey({ via: "stripe", stripe_subscription: "sub_d1" });
    expect((await app.inject({ url: "/v1/carry/eligible", headers: { "x-api-key": data.key } })).statusCode).toBe(403);
    const desk = k.createCarryKey({ via: "stripe", tier: "desk", stripe_subscription: "sub_desk1" });
    expect(desk.key.startsWith("dsi_carrydesk_")).toBe(true);
    expect((await app.inject({ url: "/v1/carry/funding-matrix", headers: { "x-api-key": desk.key } })).statusCode).toBe(200);   // desk includes data
    const a = await app.inject({ method: "POST", url: "/v1/carry/alerts", headers: { "x-api-key": desk.key }, payload: { type: "eligible_on", target: "https://example.org/hook" } });
    expect(a.statusCode).toBe(201); expect(a.json().secret.startsWith("whsec_")).toBe(true);
    expect((await app.inject({ method: "POST", url: "/v1/carry/alerts", headers: { "x-api-key": desk.key }, payload: { type: "bogus", target: "https://x.org" } })).statusCode).toBe(400);
    expect((await app.inject({ url: "/v1/carry/alerts", headers: { "x-api-key": desk.key } })).json().items).toHaveLength(1);
    const seats = k.deskSeats(); expect(seats.total).toBe(25); expect(seats.used).toBeGreaterThanOrEqual(1); expect(seats.open).toBe(false);
    k.setCarrySetting("desk_open", "1"); expect(k.deskSeats().open).toBe(true); k.setCarrySetting("desk_open", "0");
    expect((await app.inject({ url: "/carry" })).body).toContain("Carry Desk");
    expect((await app.inject({ url: "/docs/carry" })).body).toContain('id="method"');
    k.revokeBySubscription("sub_desk1"); expect(k.deskAccess(desk.key).ok).toBe(false);
  });
  it("carry tools are priced for pay-per-call and pack credits", async () => {
    const p = await import("../src/server/pricing.js");
    expect(p.PRICES.carry_xdex).toBe(0.05); expect(p.creditsFor("carry_xdex")).toBe(50); expect(p.CREDITS_SQL).toContain("carry_funding_matrix");
  });
});

describe("Carry dataset durability", () => {
  it("gap fill recovers missing hours without duplicating", async () => {
    const c = await import("../src/carry/hl.js");
    const { getDb } = await import("../src/store/db.js");
    c.ensureCarryTables(); getDb().exec("DELETE FROM hl_funding; DELETE FROM hl_spot; DELETE FROM hl_backfill;");
    await c.snapshot();
    const g1 = await c.gapFill(72, 0); expect(g1.rows_added).toBe(6);
    const g2 = await c.gapFill(72, 0); expect(g2.rows_added).toBe(0);
  });
});

describe("Free trial key + public leaderboard (ordem 05/10)", () => {
  it("issues one trial key per email, gives carry access, excludes the oracle, counts metrics", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const k = await import("../src/server/keys.js");
    const app = await buildHttp();
    const r = await app.inject({ method: "POST", url: "/v1/keys/trial", payload: { email: "dev1@example.com" }, headers: { "x-forwarded-for": "10.0.0.1" } });
    expect(r.statusCode).toBe(201);
    const j = r.json(); expect(j.api_key).toMatch(/^dsi_trial_/); expect(j.calls).toBe(200); expect(j.expires_at).toBeTruthy();
    expect((await app.inject({ method: "POST", url: "/v1/keys/trial", payload: { email: "dev1@example.com" }, headers: { "x-forwarded-for": "10.0.0.2" } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "POST", url: "/v1/keys/trial", payload: { email: "not-an-email" } })).statusCode).toBe(400);
    const ok = await app.inject({ url: "/v1/carry/funding-matrix", headers: { "x-api-key": j.api_key } });
    expect(ok.statusCode).toBe(200);
    expect(k.validateKey(j.api_key)?.plan).toBe("trial");
    expect(k.TRIAL.excluded_tools).toContain("oracle_forecast");
    expect(k.trialMetrics().trial_keys_issued).toBeGreaterThanOrEqual(1);
    for (const u of ["/carry", "/pricing"]) expect((await app.inject({ url: u })).body).toContain("/v1/keys/trial");
    expect((await app.inject({ url: "/llms.txt" })).body).toContain("/v1/keys/trial");
    expect((await app.inject({ url: "/ajuda" })).body).toContain("Como consigo uma chave?");
  });
  it("leaderboard: server-rendered, top 5, SEO tags, JSON-LD, cache + ETag, 301 alias, coin pages, sitemap", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    const r = await app.inject({ url: "/carry/leaderboard" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["cache-control"]).toContain("max-age=300"); expect(r.headers.etag).toBeTruthy();
    expect(r.body).toContain("<title>Hyperliquid funding rates leaderboard — all dexes, HIP-3 included | Degenscan Intel</title>");
    expect(r.body).toContain("<h1>Hyperliquid funding rates, every dex, every hour</h1>");
    for (const h of ["Cross-dex funding spreads (HIP-3)", "Spot × perp funding", "Funding extremes without a hedge", "Dex health", "Get the full history"]) expect(r.body).toContain(h);
    expect(r.body).toContain('"@type":"Dataset"'); expect(r.body).toContain('"@type":"Product"');
    expect(r.body).toContain("Marbella Collins LLC"); expect(r.body).toContain("não é recomendação de investimento");
    expect(r.body).not.toMatch(/\b(long|short)\b/i);
    expect((await app.inject({ url: "/carry/leaderboard", headers: { "if-none-match": r.headers.etag as string } })).statusCode).toBe(304);
    const a = await app.inject({ url: "/hyperliquid-funding-rates" });
    expect(a.statusCode).toBe(301); expect(a.headers.location).toBe("/carry/leaderboard");
    const c = await app.inject({ url: "/carry/coin/xyz:NBIS" });
    expect(c.statusCode).toBe(200); expect(c.body).toContain("<title>xyz:NBIS funding rate history on Hyperliquid (xyz) | Degenscan Intel</title>");
    expect(c.body).toContain("io:NBIS");
    expect((await app.inject({ url: "/carry/coin/NOPE123" })).statusCode).toBe(404);
    const sm = (await app.inject({ url: "/sitemap.xml" })).body;
    for (const u of ["/carry/leaderboard", "/docs/carry", "/previsoes", "/pricing", "/carry/coin/xyz%3ANBIS"]) expect(sm).toContain(u);
  });
});
