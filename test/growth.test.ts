import { describe, it, expect, afterEach } from "vitest";
import { inflections, hnStories, aroundInflections, companyGrowthSignals, _growth } from "../src/server/growth.js";

const realFetch = _growth.fetch;
describe("company_growth_signals (08/11)", () => {
  afterEach(() => { _growth.reset(); _growth.fetch = realFetch; });
  it("finds the biggest month-over-month jumps above a base", () => {
    const s = [{ month: "2025-01", value: 100 }, { month: "2025-02", value: 400 }, { month: "2025-03", value: 380 }, { month: "2025-04", value: 760 }, { month: "2025-05", value: 10 }, { month: "2025-06", value: 900 }];
    const j = inflections(s, 50, 2);
    expect(j.map(x => x.month)).toEqual(["2025-02", "2025-04"]);   // 2025-06 jump is from a base under 50
    expect(j[0].change_pct).toBe(300);
  });
  it("keeps only HN stories that name the company and flags launches", () => {
    const st = hnStories([{ objectID: "1", title: "Launch HN: Lovable (YC) – build apps", points: 400, created_at: "2025-02-24T10:00:00Z" },
      { objectID: "2", title: "A lovableness study", points: 900 }, { objectID: "3", title: "Show HN: I built X with Lovable", points: 120, created_at: "2025-03-01" }], "Lovable");
    expect(st.map(s => s.kind)).toEqual(["launch_hn", "show_hn"]);
    expect(st[0].hn_url).toBe("https://news.ycombinator.com/item?id=1");
  });
  it("attaches events from the jump month and the month before", () => {
    const r = aroundInflections([{ month: "2025-03" }], [{ date: "2025-02-24", channel: "launch_hn", title: "a" }, { date: "2025-03-10", channel: "news", title: "b" }, { date: "2025-05-01", channel: "news", title: "c" }]);
    expect(r[0].events_that_month_or_before.map(e => e.title)).toEqual(["a", "b"]);
  });
  it("assembles sources and survives a failing source", async () => {
    await expect(companyGrowthSignals({})).rejects.toMatchObject({ status: 400 });
    _growth.fetch = async (u: string) => {
      if (u.includes("rest.php/v1/search")) return new Response(JSON.stringify({ pages: [{ key: "Lovable_(company)", title: "Lovable (company)" }] }));
      if (u.includes("pageviews")) return new Response(JSON.stringify({ items: [{ timestamp: "2025020100", views: 1000 }, { timestamp: "2025030100", views: 5000 }] }));
      if (u.includes("hn.algolia.com/api/v1/search?")) return new Response(JSON.stringify({ hits: [{ objectID: "9", title: "Launch HN: Lovable", points: 300, created_at: "2025-02-20T00:00:00Z" }] }));
      if (u.includes("search_by_date")) return new Response(JSON.stringify({ nbHits: 2 }));
      if (u.includes("api.github.com/users/")) return new Response(JSON.stringify({ login: "lovable-dev", type: "Organization", created_at: "2023-06-01T00:00:00Z" }));
      if (u.includes("api.github.com/search")) return new Response(JSON.stringify({ items: [{ full_name: "lovable-dev/gpt-engineer", stargazers_count: 50000, created_at: "2023-04-29T00:00:00Z", html_url: "https://github.com/x" }] }));
      if (u.includes("gdeltproject")) return new Response("boom", { status: 500 });
      if (u.includes("archive.org")) return new Response(JSON.stringify({ archived_snapshots: { closest: { timestamp: "20231101000000", url: "http://web.archive.org/x" } } }));
      return new Response("{}");
    };
    const r = await companyGrowthSignals({ company: "Lovable", domain: "https://lovable.dev/", github: "lovable-dev" });
    expect(r.domain).toBe("lovable.dev");
    expect(r.sources_status.news_gdelt).toMatch(/error/); expect(r.sources_status.wikipedia).toBe("ok");
    expect(r.attention_jumps[0].month).toBe("2025-03");
    expect(r.attention_jumps[0].events_that_month_or_before.some(e => e.channel === "launch_hn")).toBe(true);
    expect(r.timeline[0].channel).toBe("github");
  });
});
