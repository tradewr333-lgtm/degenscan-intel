process.env.DB_PATH = ":memory:"; process.env.LIQ_GAP_MS = "0";
import { describe, it, expect, vi, beforeAll } from "vitest";
import { topAccounts, liqRound, liqMap, liqNear, smartAccounts, smartCoin, smartFlow } from "../src/carry/liq.js";
import { coinSnapshot } from "../src/server/coin.js";
import { parseInstrument, toOpts, analyse, maxPain, callDelta } from "../src/server/options.js";

const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40), C = "0x" + "c".repeat(40);
const lbRow = (a: string, v: number) => `{"ethAddress": "${a}", "accountValue": "1000", "windowPerformances": [["day", {"pnl": "1", "roi": "0", "vlm": "1"}], ["month", {"pnl": "5", "roi": "0.1", "vlm": "${v}"}]]}`;
const LB = `{"leaderboardRows": [${lbRow(A, 5e9)}, ${lbRow(B, 9e9)}, ${lbRow(C, 0)}]}`;
let round = 0;

describe("Hyperliquid liquidation map", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", async (u: string, init: any) => {
      if (String(u).includes("leaderboard")) return new Response(LB);
      if (!init?.body) throw new Error("get " + u); const b = JSON.parse(init.body);
      if (b.type === "metaAndAssetCtxs") return Response.json([{ universe: [{ name: "BTC" }] }, [{ markPx: "100000", openInterest: "10000" }]]);
      if (b.type === "clearinghouseState") {
        if (b.user === A) return Response.json({ assetPositions: [{ position: { coin: "BTC", szi: "10", entryPx: "98000", positionValue: "1000000", liquidationPx: "95000", leverage: { value: 10 } } }] });
        // B: short near liquidation in round 1, liquidated in round 2
        return Response.json({ assetPositions: round === 0 ? [{ position: { coin: "BTC", szi: "-5", entryPx: "99000", positionValue: "500000", liquidationPx: "103000", leverage: { value: 20 } } }] : [] });
      }
      if (!init?.body) throw new Error("no body"); if (b.type === "userFillsByTime") return Response.json([{ coin: "BTC", side: "B", sz: "5", px: "103000", time: Date.now() - 60_000, tid: 1, liquidation: { liquidatedUser: B } }]);
      throw new Error("unexpected " + JSON.stringify(b));
    });
  });
  it("ranks accounts by 30-day volume and skips zero volume", () => { expect(topAccounts(LB, 5)).toEqual([B, A]); });
  it("smart money = positive 30-day PnL and ROI with ≥ $5M volume", () => { expect(smartAccounts(LB).map(x => x.a).sort()).toEqual([A, B].sort()); });
  it("aggregates bands, nearest clusters and confirmed liquidations", async () => {
    await liqRound(); let m: any = await liqMap("btc");
    expect(m.longs.notional_usd).toBe(1_000_000); expect(m.shorts.notional_usd).toBe(500_000);
    expect(m.nearest_long_liquidation.distance_pct).toBe(-5); expect(m.nearest_short_liquidation.distance_pct).toBe(3);
    expect(m.liquidation_bands.find((x: any) => x.side === "short").from_pct).toBe(2);
    expect(m.coverage_pct_of_oi).toBe(0.08);
    const near: any = await liqNear(5); expect(near.items[0]).toMatchObject({ coin: "BTC", longs_near_liq_usd: 1_000_000, shorts_near_liq_usd: 500_000 });
    const before = m.liquidations_24h.count; round = 1; await liqRound(); m = await liqMap("BTC");
    const sc: any = await smartCoin("BTC", 1); expect(sc.flow.largest[0]).toMatchObject({ action: "close_short", delta_usd: 500000 });
    expect(sc.smart.long_usd).toBe(1_000_000); expect(smartFlow(1).flows[0]).toMatchObject({ coin: "BTC" });
    const snap: any = await coinSnapshot("btc"); expect(snap === null || snap.symbol === "BTC").toBe(true);
    expect(m.shorts.positions).toBe(0); expect(m.liquidations_24h.count).toBe(before + 1); expect(m.liquidations_24h.largest[0]).toMatchObject({ side: "short", value_usd: 515000 });
  });
});

describe("Deribit options analytics", () => {
  it("parses instruments, deltas and max pain", () => {
    expect(parseInstrument("BTC-19OCT26-71000-C")).toMatchObject({ expiry: "19OCT26", strike: 71000, type: "C" });
    expect(callDelta(100, 100, 50, 0.1)).toBeGreaterThan(0.5); expect(callDelta(100, 150, 50, 0.1)).toBeLessThan(0.1);
    const now = Date.UTC(2026, 9, 17);
    const mk = (k: number, t: string, iv: number, oi: number) => ({ instrument_name: `BTC-30OCT26-${k}-${t}`, mark_iv: iv, open_interest: oi, volume: 1, underlying_price: 100000 });
    const rows = [80000, 90000, 95000, 100000, 105000, 110000, 120000].flatMap(k => [mk(k, "C", 40 + (k < 100000 ? 3 : 0), k === 110000 ? 500 : 50), mk(k, "P", 40 + (k < 100000 ? 6 : 0), k === 90000 ? 400 : 50)]);
    const o = toOpts(rows); expect(maxPain(o)).toBeGreaterThan(90000);
    const a = analyse("BTC", o, now); const t = a.term[0];
    expect(t.atm_iv).toBe(40); expect(t.rr25).toBeLessThan(0); expect(a.put_call.oi_ratio).toBe(0.88);
  });
});
