import { describe, it, expect, beforeEach } from "vitest";
import { perpSymbol, perpRows, historyStats, deribitPerps, _dp } from "../src/server/deribitperps.js";
import { renderTradingKit, KIT_TOOLS } from "../src/server/kits.js";
import { PRICES } from "../src/server/pricing.js";

const BTC = [{ instrument_name: "BTC-PERPETUAL", open_interest: 685965510, volume_usd: 2690655380, funding_8h: 0.00012861, current_funding: 0.00005697, mark_price: 75862.17, estimated_delivery_price: 75838.89 },
  { instrument_name: "BTC-27NOV26", open_interest: 1, mark_price: 76000 }];
const USDC = [{ instrument_name: "SOL_USDC-PERPETUAL", open_interest: 100000, volume_usd: 5e6, funding_8h: -0.0001, current_funding: 0, mark_price: 89.5, estimated_delivery_price: 89.6 },
  { instrument_name: "1000PEPE_USDC-PERPETUAL", open_interest: 10, volume_usd: 1e5, funding_8h: 0.0003, mark_price: 0.01, estimated_delivery_price: 0.01 }];

describe("deribit_perps", () => {
  beforeEach(() => _dp.reset());
  it("parses symbols", () => { expect(perpSymbol("BTC-PERPETUAL")).toBe("BTC"); expect(perpSymbol("SOL_USDC-PERPETUAL")).toBe("SOL"); expect(perpSymbol("BTC-27NOV26")).toBeNull(); });
  it("derives rows: inverse OI in USD, linear OI × mark, APR, premium, HL gap", () => {
    const rows = perpRows([...BTC, ...USDC], new Map([["BTC", 0.0000125], ["SOL", 0.00001], ["KPEPE", 0.00002]]));
    expect(rows.length).toBe(3);
    const b = rows.find(r => r.symbol === "BTC")!;
    expect(b.open_interest_usd).toBe(685965510); expect(b.funding_apr_pct).toBeCloseTo(14.08, 1); expect(b.hyperliquid_funding_apr_pct).toBeCloseTo(10.95, 1);
    expect(b.funding_gap_vs_hyperliquid_apr_pct).toBeCloseTo(3.13, 1); expect(b.premium_bp).toBeCloseTo(3.07, 1);
    const s = rows.find(r => r.symbol === "SOL")!; expect(s.open_interest_usd).toBe(8950000); expect(s.margin).toContain("linear"); expect(s.funding_apr_pct).toBeCloseTo(-10.95, 1);
    expect(rows.find(r => r.symbol === "1000PEPE")!.hyperliquid_funding_apr_pct).not.toBeNull();
  });
  it("history stats", () => {
    const h = Array.from({ length: 168 }, (_, i) => ({ timestamp: 1e12 + i * 3600e3, interest_1h: i % 2 ? 0.00001 : -0.00001 }));
    const s = historyStats(h); expect(s.hours).toBe(168); expect(s.last_7d!.paid_pct).toBeCloseTo(0, 6); expect(s.positive_hours_pct).toBe(50); expect(s.hourly.length).toBe(48);
  });
  it("end to end with mocked Deribit: filter, sort, one-symbol history", async () => {
    _dp.fetch = (async (u: string) => ({ ok: true, json: async () => ({ result: u.includes("currency=BTC") ? BTC : u.includes("currency=USDC") ? USDC : u.includes("funding_rate_history") ? [{ timestamp: 1, interest_1h: 0.00001 }] : [] }) })) as any;
    _dp.hl = async () => new Map([["BTC", 0.00001]]);
    const all = await deribitPerps({ sort: "oi" }); expect(all.items[0].symbol).toBe("BTC"); expect(all.disclaimer).toContain("not investment advice");
    const one = await deribitPerps({ symbols: "sol" }); expect(one.count).toBe(1); expect(one.funding_history.instrument).toBe("SOL_USDC-PERPETUAL");
  });
  it("kit page lists priced tools and the disclaimer", () => {
    const html = renderTradingKit("https://x"); for (const t of KIT_TOOLS) { expect(html).toContain(t.tool); expect((PRICES as any)[t.tool]).toBeGreaterThan(0); }
    expect(html).toContain("Not affiliated"); expect(html).toContain("not investment advice");
  });
});
