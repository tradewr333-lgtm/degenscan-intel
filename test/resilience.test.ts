process.env.DB_PATH = ":memory:";
import { describe, it, expect, beforeAll, vi } from "vitest";

// 02/11: Mercado Bitcoin in maintenance took PTAX down; Fiscal Data's results lag left the 14-day auction window empty.
describe("resilience of paid routes to upstream gaps", () => {
  beforeAll(() => {
    const old = new Date(Date.now() - 18 * 86400e3).toISOString().slice(0, 10), recent = new Date(Date.now() - 3 * 86400e3).toISOString().slice(0, 10);
    vi.stubGlobal("fetch", async (u: string) => {
      const ok = (x: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(x), json: async () => x });
      if (u.includes("mercadobitcoin")) return { ok: false, status: 503, text: async () => "Plataforma em manutenção", json: async () => { throw new Error("html"); } };
      if (u.includes("bcdata.sgs.1/")) return ok([{ data: "30/10/2026", valor: "5.40" }]);
      if (u.includes("coinbase")) return ok({ data: { amount: "100000" } });
      if (u.includes("fiscaldata")) return ok({ data: [
        { auction_date: recent, security_type: "Note", security_term: "5-Year", high_yield: "null", high_discnt_rate: "null", high_investment_rate: "null" },
        { auction_date: old, security_type: "Bill", security_term: "8-Week", high_yield: "null", high_discnt_rate: "4.05", high_investment_rate: "4.13", bid_to_cover_ratio: "2.9", total_accepted: "100", indirect_bidder_accepted: "60" }] });
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    });
  });
  it("PTAX still served when Mercado Bitcoin is down", async () => {
    const M = await import("../src/server/macro.js");
    const b: any = await M.brPremium();
    expect(b.ptax.usd_brl).toBe(5.4); expect(b.crypto_dollar.usdt_brl).toBeNull(); expect(b.unavailable).toEqual(["mercadobitcoin"]);
  });
  it("auctions fall back to the most recent results when the window is empty, and say so", async () => {
    const M = await import("../src/server/macro.js");
    const t: any = await M.treasuryAuctions({ days: 14 });
    expect(t.window_extended).toBe(true); expect(t.results).toHaveLength(1); expect(t.results[0].high_discount_rate_pct).toBe(4.05); expect(t.window_note).toContain("lags");
  });
});

describe("polymarket mapping (03/11)", () => {
  it("leaderboard is not swallowed by the polymarket_context catch-all", async () => {
    const { toolForRequest } = await import("../src/server/access.js");
    expect(toolForRequest({ url: "/v1/polymarket/leaderboard?period=week", method: "GET" } as any)).toBe("polymarket_leaderboard");
    expect(toolForRequest({ url: "/v1/polymarket/fed-cut", method: "GET" } as any)).toBe("polymarket_context");
  });
});
