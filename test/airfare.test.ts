import { describe, it, expect, afterEach } from "vitest";
import { normFare, airfareSummary, airfareBenchmark, _air } from "../src/server/airfare.js";

const row = (y: number, q: number, a1: string, a2: string, fare: number, extra: any = {}) => ({ year: String(y), quarter: String(q), airport_1: a1, airport_2: a2,
  city1: "Miami, FL (Metropolitan Area)", city2: "New York City, NY (Metropolitan Area)", citymarketid_1: "32467", citymarketid_2: "31703", nsmiles: "1096",
  passengers: "900.5", fare: String(fare), carrier_lg: "AA", large_ms: "0.61", fare_lg: String(fare + 5), carrier_low: "B6", lf_ms: "0.2", fare_low: String(fare - 30), ...extra });

const realFetch = _air.fetch;
describe("airfare_benchmark (08/11)", () => {
  afterEach(() => { _air.reset(); _air.fetch = realFetch; });
  it("normalises a DOT row", () => {
    const m = normFare(row(2026, 1, "MIA", "LGA", 180));
    expect(m).toMatchObject({ period: "2026Q1", avg_fare: 180, miles: 1096, largest_carrier: { code: "AA", name: "American", market_share_pct: 61 }, lowest_fare_carrier: { code: "B6", name: "JetBlue", avg_fare: 150 } });
  });
  it("summarises YoY, seasonality and cheaper nearby airports", () => {
    const hist = [row(2026, 1, "MIA", "LGA", 200), row(2025, 4, "MIA", "LGA", 220), row(2025, 3, "MIA", "LGA", 150), row(2025, 2, "MIA", "LGA", 170), row(2025, 1, "MIA", "LGA", 160)].map(normFare);
    const alts = [row(2026, 1, "MIA", "LGA", 200), row(2026, 1, "FLL", "LGA", 140), row(2026, 1, "MIA", "JFK", 230)].map(normFare);
    const s = airfareSummary(hist, alts, "LGA", "MIA", "airport_pair");
    expect(s.latest.avg_fare_each_way).toBe(200);
    expect(s.year_over_year).toMatchObject({ prior_period: "2025Q1", change_pct: 25 });
    expect(s.seasonality?.cheapest_quarter.quarter).toBe(3);
    expect(s.seasonality?.priciest_quarter.quarter).toBe(4);
    expect(s.lower_fare_carrier?.carrier?.code).toBe("B6");
    expect(s.nearby_airports?.cheapest_alternative).toMatchObject({ airports: "FLL–LGA", avg_fare: 140, vs_requested_pct: -30 });
    expect(s.nearby_airports?.options.find(o => o.requested)?.airports).toBe("MIA–LGA");
    expect(s.route.city_from).toContain("New York");
  });
  it("validates codes, falls back to city pairs, 404s when nothing", async () => {
    await expect(airfareBenchmark({ from: "Miami", to: "JFK" })).rejects.toMatchObject({ status: 400 });
    const seen: string[] = [];
    _air.fetch = async (u: string) => { seen.push(decodeURIComponent(u));
      const d = decodeURIComponent(u);
      if (d.includes("tfrh-tu9e") && d.includes("airport_1='SYR' AND airport_2='BOI'")) return new Response("[]");
      if (d.includes("tfrh-tu9e") && d.includes("airport_1='BOI' OR")) return new Response(JSON.stringify([row(2026, 1, "BOI", "LGA", 300, { citymarketid_1: "30000" })]));
      if (d.includes("tfrh-tu9e") && d.includes("airport_1='SYR' OR")) return new Response(JSON.stringify([row(2026, 1, "SYR", "LGA", 250, { citymarketid_1: "35096" })]));
      if (d.includes("yj5y-b2ir")) return new Response(JSON.stringify([row(2026, 1, undefined as any, undefined as any, 310, { citymarketid_1: "35096", citymarketid_2: "30000" })]));
      return new Response("[]"); };
    const r = await airfareBenchmark({ from: "syr", to: "BOI" });
    expect(r.route.level).toBe("city_pair"); expect(r.latest.avg_fare_each_way).toBe(310);
    _air.reset(); _air.fetch = async () => new Response("[]");
    await expect(airfareBenchmark({ from: "AAA", to: "BBB" })).rejects.toMatchObject({ status: 404 });
  });
});
