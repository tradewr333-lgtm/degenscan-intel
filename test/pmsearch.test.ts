import { describe, it, expect } from "vitest";
import { marketOut, searchMarkets, eventOut } from "../src/server/pmsearch.js";
import { toolForRequest } from "../src/server/access.js";

describe("polymarket markets/events (04/11)", () => {
  const now = Date.parse("2026-11-04T00:00:00Z");
  const rows = [
    { id: 1, slug: "btc-88k", question: "Will the price of Bitcoin be above $88,000 on November 5?", outcomePrices: '["0.12","0.88"]', bestBid: 0.11, bestAsk: 0.13, volume24hr: 5000, liquidityNum: 40000, endDate: "2026-11-05T17:00:00Z" },
    { id: 2, slug: "fed", question: "Fed cuts rates in December?", outcomePrices: '["0.3","0.7"]', volume24hr: 9000, liquidityNum: 1000, endDate: "2026-12-10T00:00:00Z" },
    { id: 3, slug: "btc-dip", question: "Will Bitcoin dip to $55,000 by December 31?", outcomePrices: '["0.08","0.92"]', volume24hr: 7000, liquidityNum: 180000, endDate: "2027-01-01T05:00:00Z" }];
  it("normalises a market with spread", () => { expect(marketOut(rows[0])).toMatchObject({ yes_prob: 0.12, spread: 0.02, liquidity_usd: 40000 }); });
  it("text, window and liquidity filters; ranked by 24 h volume", () => {
    expect(searchMarkets(rows, { text: "bitcoin" }, now).map(m => m.id)).toEqual(["3", "1"]);
    expect(searchMarkets(rows, { text: "bitcoin", ends_within_days: 7 }, now).map(m => m.id)).toEqual(["1"]);
    expect(searchMarkets(rows, { min_liquidity: 50000 }, now).map(m => m.id)).toEqual(["3"]);
  });
  it("event with top outcomes, closed markets dropped", () => {
    const e = eventOut({ id: 9, title: "Fed decision", openInterest: 5332149.3, markets: [{ id: 1, question: "No change", outcomePrices: '["0.7","0.3"]' }, { id: 2, question: "Cut 25", outcomePrices: '["0.29","0.71"]' }, { id: 3, question: "old", closed: true }] });
    expect(e.markets).toBe(2); expect(e.top_outcomes[0]).toMatchObject({ question: "No change", yes_prob: 0.7 }); expect(e.open_interest_usd).toBe(5332149);
  });
  it("routes map before the /v1/polymarket/* catch-all", () => {
    expect(toolForRequest({ url: "/v1/polymarket/markets?q=btc", method: "GET" } as any)).toBe("polymarket_markets");
    expect(toolForRequest({ url: "/v1/polymarket/events", method: "GET" } as any)).toBe("polymarket_events");
  });
});
