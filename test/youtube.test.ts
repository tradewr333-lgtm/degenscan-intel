process.env.DB_PATH = ":memory:";
import { describe, it, expect } from "vitest";
import { channelSelector, isoSeconds, outliersFrom, growthFrom } from "../src/server/youtube.js";

describe("youtube (03/11)", () => {
  it("parses channel inputs", () => {
    expect(channelSelector("@mkbhd")).toEqual({ forHandle: "@mkbhd" });
    expect(channelSelector("https://www.youtube.com/@TradewithRenatoUlianov/videos")).toEqual({ forHandle: "@TradewithRenatoUlianov" });
    expect(channelSelector("UCBJycsmduvYEL83R_U4JriQ")).toEqual({ id: "UCBJycsmduvYEL83R_U4JriQ" });
    expect(() => channelSelector("")).toThrow(); expect(isoSeconds("PT1H2M3S")).toBe(3723); expect(isoSeconds("PT45S")).toBe(45);
  });
  it("ranks uploads by multiple of the same-format median and flags recent ones", () => {
    const now = Date.parse("2026-11-03T00:00:00Z"), d = (days: number) => new Date(now - days * 86400e3).toISOString();
    const v = (id: string, views: number, days: number, dur = "PT10M") => ({ id, snippet: { title: id, publishedAt: d(days) }, statistics: { viewCount: String(views) }, contentDetails: { duration: dur } });
    const o = outliersFrom([v("a", 100, 10), v("b", 100, 20), v("c", 1000, 30), v("d", 50, 1), v("s1", 5000, 10, "PT40S"), v("s2", 500, 12, "PT50S")], now);
    expect(o.long.median_views).toBe(100); expect(o.long.items[0]).toMatchObject({ id: "c", multiple_of_median: 10 });
    expect(o.long.items.find((x: any) => x.id === "d").too_recent).toBe(true);
    expect(o.short.median_views).toBe(2750); expect(o.short.n).toBe(2);
  });
  it("growth from daily snapshots", () => {
    const rows = Array.from({ length: 31 }, (_, i) => ({ day: new Date(Date.parse("2026-10-03") + i * 86400e3).toISOString().slice(0, 10), subs: 1000 + i * 10, views: 1e5 + i * 1000, videos: 100 }));
    const g = growthFrom(rows); expect(g.change_7d.subscribers).toMatchObject({ abs: 70 }); expect(g.change_30d.subscribers!.abs).toBe(300); expect(g.history_days).toBe(31);
    expect(growthFrom(rows.slice(0, 1)).change_7d.subscribers).toBeNull();
  });
  it("route answers 503 (not configured) without a key, after payment logic", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const Y = await import("../src/server/youtube.js");
    await expect(Y.youtubeOutliers({ channel: "@example" })).rejects.toMatchObject({ status: 503 });
  });
});
