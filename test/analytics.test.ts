process.env.DB_PATH = ":memory:";
import { describe, it, expect, beforeAll } from "vitest";
import { getDb } from "../src/store/db.js";
import { ensureCarryTables, HOUR } from "../src/carry/hl.js";
import { regime, calendar, oracleHealth, extremes, aftermath, breakeven, depthFromBook, bookDepth } from "../src/carry/analytics.js";

const T0 = Math.floor(Date.now() / HOUR) * HOUR + 400 * 24 * HOUR;  // far future: isolated from any persisted test data
describe("carry analytics", () => {
  beforeAll(() => {
    ensureCarryTables();
    const ins = getDb().prepare("INSERT OR REPLACE INTO hl_funding (coin, dex, ts, funding, premium, mark, oracle, oi, vol24, src) VALUES (?,?,?,?,?,?,?,?,?, 'snapshot')");
    for (let h = 0; h < 14 * 24; h++) {
      const ts = T0 - h * HOUR; const dow = new Date(ts).getUTCDay(); const we = dow === 0 || dow === 6;
      ins.run("zz:FLR", "zz", ts, 0.0000125, 0, 10, 10, 1e6, 5e5);                                   // always at the floor
      ins.run("zz:WKD", "zz", ts, we ? 0.000001 : 0.00005, 0, 20 + h * 0.01, h < 6 ? 7 : 7 + h, 1e6, 5e5);  // collapses on weekends; oracle frozen last 6 h
      ins.run("zz:EXT", "zz", ts, h < 3 ? 0.0005 : (h === 50 ? 0.0004 : 0.00001), 0, 100 - h * 0.1, 100, 1e6, 5e5);  // extreme now (3 h) + one past episode
      ins.run("zz:ZER", "zz", ts, h < 5 ? 0 : 0.00002, 0, 5, 5 + h, 1e6, 5e5);
    }
  });
  it("regime: floor share and regime now", () => {
    const r: any = regime({ coin: "zz:FLR" });
    expect(r.items[0]).toMatchObject({ dominant_regime: "floor", regime_now: "floor" }); expect(r.items[0].pct_hours.floor).toBe(100);
  });
  it("calendar: weekend collapse", () => {
    const c: any = calendar({ coin: "zz:WKD", days: 28 }); expect(c.items[0].collapses_on_weekend).toBe(true);
    expect(c.items[0].weekend_to_weekday_ratio).toBeLessThan(0.1);
  });
  it("oracle health: frozen funding and stale oracle", () => {
    const o: any = oracleHealth({ dex: "zz", hours: 72 });
    expect(o.flags.find((f: any) => f.coin === "zz:ZER" && f.flag === "frozen_funding")).toMatchObject({ longest_run_h: 5, ongoing: true });
    expect(o.flags.find((f: any) => f.coin === "zz:WKD" && f.flag === "stale_oracle")).toBeTruthy();
  });
  it("extremes and aftermath", () => {
    const e: any = extremes({ minAbsApr: 2 }); const x = e.items.find((i: any) => i.coin === "zz:EXT");
    expect(x.hours_in_extreme).toBe(3); expect(x.realized_apr_14d).toBeLessThan(x.funding_apr_now);
    const a: any = aftermath({ coin: "zz:EXT", minAbsApr: 2, days: 30 });
    const past = a.episodes.find((p: any) => p.onset === new Date(T0 - 50 * HOUR).toISOString());
    expect(past).toMatchObject({ hours_above_threshold: 1, half_life_h: 1 }); expect(past.price_return_pct.h4).toBeCloseTo(0.42, 1);
  });
  it("breakeven matches the HI Carry numbers (0.98 % round trip, 25.5 %/yr at 14 d)", () => {
    const b: any = breakeven({ spread_apr: 0.35, lev: 3 });
    expect(b.round_trip_cost_pct_of_notional).toBe(0.98); expect(b.breakeven_apr_by_hold["14d"]).toBeCloseTo(0.2555, 3);
    expect(() => breakeven({})).toThrow();
  });
  it("depth from an l2Book snapshot", () => {
    const d = depthFromBook([[{ px: "99.99", sz: "10" }, { px: "99.5", sz: "100" }], [{ px: "100.01", sz: "5" }, { px: "100.6", sz: "50" }]]);
    expect(Math.round(d.bid5)).toBe(1000); expect(Math.round(d.bid50)).toBe(1000 + 9950); expect(Math.round(d.ask50)).toBe(500);
  });

  it("deep books: each band measured on the finest book that reaches it", async () => {
    const lv = (step: number, sz: number) => [Array.from({ length: 20 }, (_, i) => ({ px: String(100000 - 0.5 - i * step), sz: String(sz) })), Array.from({ length: 20 }, (_, i) => ({ px: String(100000 + 0.5 + i * step), sz: String(sz) }))];
    const books: Record<string, any> = { full: { levels: lv(1, 1) }, "5": { levels: lv(10, 10) }, "4": { levels: lv(100, 100) }, "3": { levels: lv(1000, 1000) } };
    const d: any = await bookDepth("BTC", async sig => books[sig ? String(sig) : "full"]);
    expect(d.bid5).toBeGreaterThan(0); expect(d.bid50).toBeGreaterThan(d.bid20); expect(d.bid20).toBeGreaterThan(d.bid5);
  });
});
