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
  it("domain picks the right Wikipedia article and drops adjective noise on HN (14/11)", async () => {
    _growth.fetch = async (u: string) => {
      const d = decodeURIComponent(u);
      if (d.includes("wikidata.org/w/api.php") && d.includes("P856=https://lovable.dev")) return new Response(JSON.stringify({ query: { search: [{ title: "Q123" }] } }));
      if (d.includes("wikidata.org/w/api.php")) return new Response(JSON.stringify({ query: { search: [] } }));
      if (d.includes("Special:EntityData/Q123")) return new Response(JSON.stringify({ entities: { Q123: { sitelinks: { enwiki: { title: "Lovable (company)" } } } } }));
      if (d.includes("rest.php/v1/search")) return new Response(JSON.stringify({ pages: [{ key: "Loveable", title: "Loveable" }] }));
      if (d.includes("pageviews")) return new Response(JSON.stringify({ items: [] }));
      if (d.includes("restrictSearchableAttributes=url")) return new Response(JSON.stringify({ hits: [{ objectID: "1", title: "Lovable raises $400M", url: "https://lovable.dev/blog/series-c", points: 167, created_at: "2026-08-12" }, { objectID: "5", title: "Show HN: Lovable 2", url: "https://lovable.dev/x", points: 90, created_at: "2025-01-10" }] }));
      if (d.includes("hn.algolia.com/api/v1/search?")) return new Response(JSON.stringify({ hits: [
        { objectID: "2", title: "How to Build a Minimum Lovable Product", points: 144, created_at: "2022-03-25" },
        { objectID: "3", title: "Tänzer: The lovable web server framework", points: 66, created_at: "2025-03-16" },
        { objectID: "4", title: "Is Lovable getting monetization wrong?", points: 140, created_at: "2025-06-25" }] }));
      if (d.includes("search_by_date")) return new Response(JSON.stringify({ nbHits: 1 }));
      return new Response("{}");
    };
    const r: any = await companyGrowthSignals({ company: "Lovable", domain: "lovable.dev" });
    expect(r.wikipedia.article).toBe("Lovable (company)"); expect(r.wikipedia.matched_by).toBe("official_website");
    const titles = r.hacker_news.top_stories.map((x: any) => x.title);
    expect(titles).toEqual(["Lovable raises $400M", "Is Lovable getting monetization wrong?", "Show HN: Lovable 2"]);
    expect(r.hacker_news.top_stories[0].links_to_site).toBe(true);
  });
});
