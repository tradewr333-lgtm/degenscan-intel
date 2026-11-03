import { describe, it, expect } from "vitest";
import { unitsOf, recallsFrom, importsFrom } from "../src/server/products.js";

describe("product research (03/11)", () => {
  it("parses recall unit counts", () => {
    expect(unitsOf("About 2 million (In addition, about 250,000 were sold in Canada)")).toBe(2_000_000);
    expect(unitsOf("About 187,400 (In addition, about 99,900 were sold in Canada)")).toBe(187_400);
    expect(unitsOf("")).toBeNull();
  });
  it("normalises CPSC recalls with totals", () => {
    const rows = [
      { RecallNumber: "1", RecallDate: "2024-03-14T00:00:00", Title: "A", Products: [{ Name: "Fryer", NumberOfUnits: "About 6,400" }], Retailers: [{ Name: "Online at Amazon.com" }], ManufacturerCountries: [{ Country: "China" }], RemedyOptions: [{ Option: "Refund" }], Hazards: [{ Name: "fire" }] },
      { RecallNumber: "2", RecallDate: "2022-04-21T00:00:00", Title: "B", Products: [{ Name: "Fryer", NumberOfUnits: "About 1 million" }], Retailers: [{ Name: "Best Buy" }], ManufacturerCountries: [{ Country: "China" }] }];
    const r = recallsFrom(rows);
    expect(r.count).toBe(2); expect(r.units_us_total).toBe(1_006_400); expect(r.sold_on_amazon).toBe(1); expect(r.items[0].recall_number).toBe("1");
    expect(r.by_country_of_manufacture[0]).toEqual({ k: "China", n: 2 }); expect(recallsFrom(rows, "2023-01-01").count).toBe(1);
  });
  it("Census imports: totals, origins (groups excluded), YoY", () => {
    const h = ["CTY_CODE", "CTY_NAME", "GEN_VAL_MO", "GEN_QY1_MO", "UNIT_QY1", "I_COMMODITY_SDESC", "I_COMMODITY", "time"];
    const row = (c: string, n: string, v: number, q: number, t: string) => [c, n, String(v), String(q), "NO", "TOYS", "9503", t];
    const t = [h, row("-", "TOTAL FOR ALL COUNTRIES", 100, 50, "2025-07"), row("-", "TOTAL FOR ALL COUNTRIES", 120, 60, "2026-07"),
      row("5700", "CHINA", 90, 45, "2026-07"), row("0003", "EUROPEAN UNION", 20, 10, "2026-07"), row("5520", "VIETNAM", 30, 15, "2026-07"), row("7910", "SOUTH AFRICA", 1, 1, "2026-07")];
    const r = importsFrom(t)!;
    expect(r.last_month).toBe("2026-07"); expect(r.last_month_value_usd).toBe(120); expect(r.yoy_month_pct).toBe(20);
    expect(r.top_origins_last_month.map(o => o.country)).toEqual(["CHINA", "VIETNAM", "SOUTH AFRICA"]); expect(r.top_origins_last_month[0].share_pct).toBe(75);
  });
});
