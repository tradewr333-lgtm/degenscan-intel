import { describe, it, expect } from "vitest";
import { gasFromHistory, basisFrom } from "../src/server/scoutrep.js";

describe("scout replicas", () => {
  it("gas from feeHistory", () => {
    const g = 1e9; const h = (x: number) => "0x" + Math.round(x).toString(16);
    const fh = { oldestBlock: h(100), baseFeePerGas: [h(0.004 * g), h(0.005 * g), h(0.006 * g)], gasUsedRatio: [0.4, 0.6],
      reward: [[h(0.0001 * g), h(0.001 * g), h(0.01 * g)], [h(0.0001 * g), h(0.001 * g), h(0.02 * g)]] };
    const o = gasFromHistory(fh, 4000);
    expect(o.next_base_fee_gwei).toBeCloseTo(0.006, 6);
    expect(o.base_fee_gwei).toBeCloseTo(0.005, 6);
    expect(o.priority_fee_gwei.p50).toBeCloseTo(0.001, 6);
    expect(o.suggested.medium.max_fee_gwei).toBeCloseTo(0.013, 6);
    expect(o.block_fullness_pct).toBe(50);
    expect(o.l2_execution_cost.eth_transfer.usd).toBeCloseTo(21000 * 0.007e9 / 1e18 * 4000, 6);
  });
  it("basis from ctx + predicted", () => {
    const ctx = { markPx: "100.1", oraclePx: "100", midPx: "100.05", funding: "0.0000125", premium: "0.0002", impactPxs: ["100.0", "100.1"], openInterest: "10", dayNtlVlm: "5000" };
    const pred = [["HlPerp", { fundingRate: "0.0000125", nextFundingTime: 1761700000000, fundingIntervalHours: 1 }], ["BinPerp", { fundingRate: "0.0001", nextFundingTime: 1761700000000, fundingIntervalHours: 8 }], ["BybitPerp", null]];
    const b = basisFrom("BTC", ctx, pred, { a24: 0.00001, a7d: null, pos7d: 90 });
    expect(b.mark_oracle_premium_bps).toBeCloseTo(10, 2);
    expect(b.funding.apr_pct).toBeCloseTo(10.95, 2);
    expect(b.predicted_funding.map(p => p.venue)).toEqual(["hyperliquid", "binance"]);
    expect(b.predicted_funding[1].apr_pct).toBeCloseTo(10.95, 2);
    expect(b.open_interest_usd).toBe(1001);
  });
});
import { candlesFrom, leaderboardFrom } from "../src/server/scoutrep.js";
describe("scout replicas 2", () => {
  it("candles summary", () => {
    const o = candlesFrom("BTC", "1h", [{ t: 0, o: "100", h: "110", l: "95", c: "105", v: "2", n: 5 }, { t: 3600000, o: "105", h: "120", l: "100", c: "118", v: "1", n: 3 }])!;
    expect(o.n).toBe(2); expect(o.summary.change_pct).toBe(18); expect(o.summary.high).toBe(120); expect(o.summary.low).toBe(95);
    expect(o.summary.range_pct).toBeCloseTo(26.316, 2); expect(o.candles[1].trades).toBe(3);
  });
  it("leaderboard compact", () => {
    const l = leaderboardFrom([{ rank: "1", proxyWallet: "0xabc", userName: "Bob", vol: 1000, pnl: 50, profileImage: "x" }, { rank: "2", proxyWallet: "0xdef", userName: "0xb0e74DF9430A089Aa102e2207Af5fde1967439D2-1789545517033", vol: 0, pnl: 5 }]);
    expect(l[0]).toEqual({ rank: 1, wallet: "0xabc", name: "Bob", pnl_usd: 50, volume_usd: 1000, pnl_to_volume_pct: 5 });
    expect(l[1].name).toBeNull(); expect(l[1].pnl_to_volume_pct).toBeNull();
  });
});
import { abiString } from "../src/server/scoutrep.js";
describe("abiString", () => { it("decodes dynamic and bytes32", () => {
  expect(abiString("0x" + "20".padStart(64, "0") + "4".padStart(64, "0") + Buffer.from("USDC").toString("hex").padEnd(64, "0"))).toBe("USDC");
  expect(abiString("0x" + Buffer.from("MKR").toString("hex").padEnd(64, "0"))).toBe("MKR"); }); });
