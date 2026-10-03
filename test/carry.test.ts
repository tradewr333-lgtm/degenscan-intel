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
      if (b.type === "spotMetaAndAssetCtxs") return json([{ universe: [{ name: "@1", tokens: [1, 0] }], tokens: [{ index: 0, name: "USDC" }, { index: 1, name: "BTC" }] }, [{ coin: "@1", markPx: "59990", dayNtlVlm: "1000000" }]]);
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
    await c.backfillMissing(coins, 0);           // second pass: nothing to do
    expect(c.carryStats().backfill.rows).toBe(6);
  });
});
