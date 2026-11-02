import { describe, it, expect } from "vitest";
import { demandFrom } from "../src/server/topics.js";

describe("topic_demand", () => {
  it("summarises 60 days of Wikimedia daily views", () => {
    const items = Array.from({ length: 60 }, (_, i) => ({ timestamp: `2026${String(9 + Math.floor((i + 3) / 31)).padStart(2, "0")}${String(((i + 3) % 31) + 1).padStart(2, "0")}00`, views: i < 53 ? 100 : 150 }));
    const d = demandFrom(items);
    expect(d.avg_7d).toBe(150); expect(d.avg_prev_7d).toBe(100); expect(d.change_7d_pct).toBe(50); expect(d.trend).toBe("rising");
    expect(d.daily_30d).toHaveLength(30); expect(d.peak_60d!.views).toBe(150); expect(d.avg_prev_30d).toBe(100);
  });
  it("short history: no 30d comparison, steady when flat", () => {
    const d = demandFrom(Array.from({ length: 14 }, (_, i) => ({ timestamp: `202610${String(i + 1).padStart(2, "0")}00`, views: 10 })));
    expect(d.trend).toBe("steady"); expect(d.avg_prev_30d).toBeNull();
  });
});
