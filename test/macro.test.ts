process.env.DB_PATH = ":memory:";
import { describe, it, expect, beforeAll, vi } from "vitest";

describe("Lote public-apis: Brazil premium, stablecoins, Treasury auctions, DeFi yields", () => {
  beforeAll(() => {
    const today = new Date().toISOString().slice(0, 10), later = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);
    vi.stubGlobal("fetch", async (u: string) => {
      const ok = (x: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(x), json: async () => x });
      if (u.includes("mercadobitcoin")) return ok([{ pair: "BTC-BRL", last: "510000" }, { pair: "USDT-BRL", last: "5.10" }, { pair: "USDC-BRL", last: "5.05" }]);
      if (u.includes("bcdata.sgs.1/")) return ok([{ data: "05/10/2026", valor: "5.00" }]);
      if (u.includes("coinbase")) return ok({ data: { amount: "100000" } });
      if (u.includes("stablecoins.llama.fi")) return ok({ peggedAssets: [
        { symbol: "USDT", name: "Tether", pegType: "peggedUSD", pegMechanism: "fiat-backed", price: 1.0, circulating: { peggedUSD: 110 }, circulatingPrevDay: { peggedUSD: 109 }, circulatingPrevWeek: { peggedUSD: 100 }, circulatingPrevMonth: { peggedUSD: 100 }, chains: ["a"] },
        { symbol: "BADUSD", name: "Bad", pegType: "peggedUSD", price: 0.98, circulating: { peggedUSD: 50_000_000 }, circulatingPrevDay: { peggedUSD: 50_000_000 }, circulatingPrevWeek: { peggedUSD: 50_000_000 }, circulatingPrevMonth: { peggedUSD: 50_000_000 }, chains: [] }] });
      if (u.includes("fiscaldata")) return ok({ data: [
        { auction_date: later, security_type: "Bill", security_term: "4-Week", high_yield: "null", high_discnt_rate: "null", high_investment_rate: "null", offering_amt: "80000000000" },
        { auction_date: today, security_type: "Note", security_term: "3-Year", high_yield: "4.9320", bid_to_cover_ratio: "2.62", total_accepted: "100", indirect_bidder_accepted: "55", direct_bidder_accepted: "30", primary_dealer_accepted: "15", offering_amt: "58000000000", int_rate: "4.875", cusip: "X", maturity_date: "2029-10-15" }] });
      if (u.includes("yields.llama.fi")) return ok({ data: [
        { project: "sky", chain: "Ethereum", symbol: "SUSDS", tvlUsd: 4.8e9, apy: 3.6, apyBase: 3.6, apyReward: null, apyMean30d: 3.6, stablecoin: true, pool: "p1" },
        { project: "farm", chain: "Base", symbol: "USDC", tvlUsd: 2e7, apy: 12, apyBase: 2, apyReward: 10, stablecoin: true, pool: "p2", outlier: true },
        { project: "tiny", chain: "Base", symbol: "USDC", tvlUsd: 5e5, apy: 50, stablecoin: true, pool: "p3" }] });
      return { ok: false, status: 404, text: async () => "", json: async () => ({}) };
    });
  });
  it("computes premiums, supply changes, auction shares and yield filters", async () => {
    const M = await import("../src/server/macro.js");
    const b = await M.brPremium();
    expect(b.crypto_dollar.usdt_premium_vs_ptax_pct).toBeCloseTo(2, 3);
    expect(b.btc.premium_vs_ptax_pct).toBeCloseTo(2, 3);        // 510000 / (100000×5) − 1
    expect(b.btc.premium_vs_usdt_pct).toBeCloseTo(0, 3);        // 510000 / (100000×5.10) − 1
    const s = await M.stablecoinSupply();
    expect(s.items[0].symbol).toBe("BADUSD"); expect(s.totals_usd_pegged.change_7d).toBe(10);
    expect(s.depegged_over_50bps.map((x: any) => x.symbol)).toEqual(["BADUSD"]);
    const t = await M.treasuryAuctions();
    expect(t.results[0].primary_dealer_pct).toBe(15); expect(t.results[0].bid_to_cover).toBe(2.62); expect(t.upcoming[0].security_term).toBe("4-Week");
    const y = await M.defiYields();
    expect(y.items.map((i: any) => i.project)).toEqual(["farm", "sky"]); expect(y.items[0].reward_share_pct).toBeCloseTo(83.3, 1);
  });
  it("routes, pricing, discovery and MCP tools are wired", async () => {
    const { buildHttp } = await import("../src/server/http.js");
    const app = await buildHttp();
    for (const u of ["/v1/br/premium", "/v1/stablecoins", "/v1/treasury/auctions", "/v1/defi/yields"]) { const r = await app.inject({ url: u }); expect(r.statusCode).toBe(200); expect(r.json().disclaimer).toContain("not investment advice"); }
    const { PRICES } = await import("../src/server/pricing.js");
    expect(PRICES.br_premium).toBe(0.002); expect(PRICES.treasury_auctions).toBe(0.003);
    expect((await app.inject({ url: "/llms.txt" })).body).toContain("/v1/br/premium");
    expect(JSON.stringify((await app.inject({ url: "/openapi.json" })).json().paths)).toContain("/v1/treasury/auctions");
    const { buildMcpServer } = await import("../src/server/mcp.js");
    const names = Object.keys((buildMcpServer() as any)._registeredTools ?? {});
    for (const n of ["br_premium", "stablecoin_supply", "treasury_auctions", "defi_yields"]) expect(names).toContain(n);
  });
});
