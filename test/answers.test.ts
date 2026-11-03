import { describe, it, expect } from "vitest";
import { ANSWERS, renderPage, renderIndex } from "../src/server/answers.js";

const SAMPLE: Record<string, any> = {
  hl_basis: { coin: "BTC", mark: 81250, oracle: 81230, mark_oracle_premium_bps: 2.46, funding: { hourly: 0.0000125, apr_pct: 10.95, apr_24h_mean_pct: 9.8, apr_7d_mean_pct: 11.2, positive_share_7d_pct: 92.3 }, predicted_funding: [{ venue: "binance", apr_pct: 8.4 }], open_interest_usd: 2.1e9, as_of: "2026-11-02T17:00:00.000Z" },
  funding_alerts: { threshold_abs_rate_1h: 0.0001, alerts: [{ symbol: "SAND", annualized_pct: -120.5, side_paying: "shorts", open_interest_usd: 5e6 }] },
  gas_base: { base_fee_gwei: 0.0052, next_base_fee_gwei: 0.0051, priority_fee_gwei: { p50: 0.001 }, suggested: { medium: { max_fee_gwei: 0.0112 } }, l2_execution_cost: { eth_transfer: { usd: 0.0005 }, erc20_transfer: { usd: 0.0016 } }, eth_usd: 3900 },
  ai_models_by_task: { items: [{ id: "openai/whisper", downloads_30d: 4e6, likes: 5000, license: "mit" }] },
  ai_cheapest: { items: [{ id: "p/m", input_per_1m: 0.05, output_per_1m: 0.2, context: 128000 }] },
  ai_models: { n_total: 457, items: [{ id: "anthropic/x", provider: "anthropic", input_per_1m: 0.1, output_per_1m: 0.5, context: 1e6 }] },
  stable_yield_best: { best_by_asset: [{ asset: "USDC", best: { project: "aave-v3", chain: "Base", apy_pct: 5.4, apy_base_pct: 4.9, tvl_usd: 3.1e8 } }], usdc_by_chain: [{ project: "aave-v3", chain: "Base", apy_pct: 5.4 }] },
  treasury_auctions: { results: [{ auction_date: "2026-10-06", security_term: "3-Year", high_yield_pct: 4.932, bid_to_cover: 2.62, indirect_pct: 55.3 }] },
  options_summary: { index_price: 81256.9, dvol: { now: 37.43, change_24h: -1.2 }, term_structure: [{ expiry: "24OCT26", days: 6.6, atm_iv: 36.9, rr25: -2.4, max_pain: 80000 }], put_call: { oi_ratio: 0.71 } },
  br_ptax: { ptax_usd_brl: 4.9698, ptax_date: "06/10/2026", usdt_brl: 5.0038, usdt_premium_vs_ptax_pct: 0.684, btc_premium_vs_ptax_pct: 0.695 },
  polymarket_leaderboard: { items: [{ rank: 1, wallet: "0xf0…", name: "BreakTheBank", pnl_usd: 3786070.64, volume_usd: 42300738.22 }] },
};

describe("live answer pages", () => {
  it("every page renders with real-shaped data and with an empty upstream body (never throws)", () => {
    for (const a of ANSWERS) {
      const html = renderPage(a, SAMPLE[a.tool] ?? {}, "https://x", 0.001);
      expect(html).toContain("<h1>"); expect(html).toContain("application/ld+json"); expect(html).toContain("not investment advice");
      expect(() => renderPage(a, {}, "https://x", 0.001)).not.toThrow();
    }
    expect(new Set(ANSWERS.map(a => a.slug)).size).toBe(ANSWERS.length);
  });
  it("answer text carries the live number; HTML is escaped", () => {
    const btc = ANSWERS.find(a => a.slug === "btc-funding-rate-hyperliquid")!;
    expect(renderPage(btc, SAMPLE.hl_basis, "https://x", 0.001)).toContain("10.95% a year");
    const evil = ANSWERS.find(a => a.tool === "polymarket_leaderboard")!;
    expect(renderPage(evil, { items: [{ rank: 1, name: "<script>x</script>", pnl_usd: 1, volume_usd: 1 }] }, "https://x", 0.002)).not.toContain("<script>x</script>");
  });
  it("index lists every page", () => {
    const html = renderIndex("https://x"); for (const a of ANSWERS) expect(html).toContain(`/answers/${a.slug}`);
  });
  it("routes: index 200 html, unknown slug 404", async () => {
    process.env.DB_PATH = ":memory:";
    const { buildHttp } = await import("../src/server/http.js"); const app = await buildHttp();
    const i = await app.inject({ method: "GET", url: "/answers" }); expect(i.statusCode).toBe(200); expect(String(i.headers["content-type"])).toContain("text/html");
    const u = await app.inject({ method: "GET", url: "/answers/nope" }); expect(u.statusCode).toBe(404);
    const sm = await app.inject({ method: "GET", url: "/sitemap.xml" }); expect(sm.body).toContain("/answers/btc-funding-rate-hyperliquid");
  });
});
