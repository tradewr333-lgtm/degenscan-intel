/**
 * Company growth signals (08/11, Renato — "REA-growth" post). REA-growth chains paid third-party APIs (ad libraries,
 * SEO tools) that we must not resell. This tool builds the honest, PRIMARY-source part of a growth teardown: a dated
 * timeline of public attention and launches, with the months where attention jumped and what happened around them.
 *  - Wikipedia (Wikimedia pageviews API): monthly human views of the company's article, up to 36 months.
 *  - Hacker News (official Algolia HN API): stories naming the company — monthly count + top stories by points
 *    (Show HN / Launch HN flagged).
 *  - GitHub REST API: the org's most-starred public repos with creation dates (when a github handle exists).
 *  - GDELT DOC 2.0: news articles from the last ~3 months (GDELT's own rolling window).
 *  - Wayback Machine: the first archived capture of the domain (a proxy for "site went live").
 * No ads, no traffic estimates, no backlinks — those are third-party paid data. No LLM: the agent writes the playbook.
 */
import { UA } from "../ingest/http.js";

const memo = new Map<string, { at: number; v: any }>();
export const _growth = {
  reset() { memo.clear(); },
  fetch: (u: string) => fetch(u, { headers: { "user-agent": `${UA} (contact@degenscan.io)`, accept: "application/json" }, signal: AbortSignal.timeout(15_000) }),
};
async function getJson(url: string, ttl = 12 * 3600_000): Promise<any> {
  const c = memo.get(url); if (c && Date.now() - c.at < ttl) return c.v;
  try {
    const res = await _growth.fetch(url);
    if (res.status === 404) { memo.set(url, { at: Date.now(), v: null }); return null; }
    if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: 502 });
    const t = await res.text(); const v = t.trim() ? JSON.parse(t) : null; memo.set(url, { at: Date.now(), v }); return v;
  } catch (e) { if (c) return c.v; throw e; }
}
const pct = (a: number | null, b: number | null) => a == null || b == null || !b ? null : Math.round((a / b - 1) * 1000) / 10;
const month = (d: Date) => d.toISOString().slice(0, 7);
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");

/** Pure: monthly series → months with the largest month-over-month jump (base ≥ minBase). Exported for tests. */
export function inflections(series: { month: string; value: number }[], minBase = 50, top = 3) {
  const out: { month: string; value: number; prev: number; change_pct: number }[] = [];
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1].value, v = series[i].value;
    if (p >= minBase && v > p) out.push({ month: series[i].month, value: v, prev: p, change_pct: pct(v, p)! });
  }
  return out.sort((a, b) => b.change_pct - a.change_pct).slice(0, top).sort((a, b) => a.month.localeCompare(b.month));
}

/** Pure: HN Algolia hits → stories that really name the company. Exported for tests. */
export function hnStories(hits: any[], name: string) {
  const re = new RegExp(`(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
  return (hits ?? []).filter(h => h?.title && re.test(String(h.title).toLowerCase())).map(h => ({
    date: String(h.created_at ?? "").slice(0, 10), title: String(h.title), points: Number(h.points ?? 0), comments: Number(h.num_comments ?? 0),
    kind: /^launch hn/i.test(h.title) ? "launch_hn" : /^show hn/i.test(h.title) ? "show_hn" : "story",
    url: h.url ?? null, hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`,
  })).sort((a, b) => b.points - a.points);
}

/** Pure: events + inflection months → each inflection with what happened that month and the month before. */
export function aroundInflections(infl: { month: string }[], events: { date: string; channel: string; title: string }[]) {
  return infl.map(i => {
    const [y, m] = i.month.split("-").map(Number); const prev = month(new Date(Date.UTC(y, m - 2, 1)));
    return { ...i, events_that_month_or_before: events.filter(e => e.date.startsWith(i.month) || e.date.startsWith(prev)).slice(0, 8) };
  });
}

const clean = (s: unknown) => String(s ?? "").trim();
/** Wikidata: the enwiki article of the entity whose official website (P856) is the domain. Avoids "Lovable" → "Loveable" (14/11). */
async function wikiByDomain(domain: string): Promise<string | null> {
  const root = domain.split(".").slice(-2).join(".");
  const hosts = [...new Set([domain, root, `www.${root}`])];
  for (const h of hosts) for (const u of [`https://${h}`, `https://${h}/`, `http://${h}`, `http://${h}/`]) {
    const r = await getJson(`https://www.wikidata.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(`haswbstatement:P856=${u}`)}&srlimit=1&format=json`, 7 * 86_400_000).catch(() => null);
    const qid = r?.query?.search?.[0]?.title; if (!qid) continue;
    const e = await getJson(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`, 7 * 86_400_000).catch(() => null);
    const t = e?.entities?.[qid]?.sitelinks?.enwiki?.title; if (t) return t;
  }
  return null;
}
async function wiki(name: string, override: string, months: number, domain = "") {
  let key: string | null = null, title: string | null = null, matched_by = "name_search";
  if (override) matched_by = "wikipedia_param";
  else if (domain) { const t = await wikiByDomain(domain); if (t) { title = t; key = t.replace(/ /g, "_"); matched_by = "official_website"; } }
  if (!key) {
    const s = await getJson(`https://en.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(override || name)}&limit=1`);
    const p = s?.pages?.[0]; if (!p?.key) return { found: false };
    key = p.key; title = p.title;
  }
  const page = { key: key!, title: title! };
  const end = new Date(); end.setUTCDate(1); const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, 1));
  const pv = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia.org/all-access/user/${encodeURIComponent(page.key)}/monthly/${ymd(start)}00/${ymd(end)}00`);
  const series = ((pv?.items ?? []) as any[]).map(i => ({ month: `${String(i.timestamp).slice(0, 4)}-${String(i.timestamp).slice(4, 6)}`, value: Number(i.views) || 0 }));
  return { found: true, article: page.title, matched_by,
    ...(matched_by === "name_search" ? { warning: "matched by name only; check the article is the company (pass wikipedia= or domain=)" } : {}), url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`, monthly_views: series, attention_jumps: inflections(series, 300) };
}
async function hn(name: string, months: number, domain = "") {
  const top = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(name)}&tags=story&hitsPerPage=100`);
  let stories = hnStories(top?.hits ?? [], name);
  if (domain) {
    // stories that link to the company's own site are certain; name-only stories must use the proper noun
    // (capitalised) and fall on/after the first site-linked story minus a year — drops "minimum lovable product" (14/11)
    const root = domain.split(".").slice(-2).join(".");
    const own = await getJson(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(root)}&restrictSearchableAttributes=url&tags=story&hitsPerPage=100`).catch(() => null);
    const ownStories = ((own?.hits ?? []) as any[]).filter(h => h?.title && String(h.url ?? "").toLowerCase().includes(root)).map(h => ({
      date: String(h.created_at ?? "").slice(0, 10), title: String(h.title), points: Number(h.points ?? 0), comments: Number(h.num_comments ?? 0),
      kind: /^launch hn/i.test(h.title) ? "launch_hn" : /^show hn/i.test(h.title) ? "show_hn" : "story", url: h.url ?? null, hn_url: `https://news.ycombinator.com/item?id=${h.objectID}`, links_to_site: true }));
    const first = ownStories.map(x => x.date).filter(Boolean).sort()[0] ?? null;
    const floor = first ? new Date(Date.parse(first) - 365 * 86_400_000).toISOString().slice(0, 10) : null;
    const proper = new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`);
    const seen = new Set(ownStories.map(x => x.hn_url));
    stories = [...ownStories, ...stories.filter(x => !seen.has(x.hn_url) && proper.test(x.title) && (!floor || x.date >= floor)).map(x => ({ ...x, links_to_site: false }))]
      .sort((a, b) => b.points - a.points);
  }
  const now = new Date(); const counts: { month: string; value: number }[] = [];
  await Promise.all(Array.from({ length: months }, async (_, k) => {
    const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)), b = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k + 1, 1));
    const r = await getJson(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(name)}&tags=story&hitsPerPage=0&numericFilters=${encodeURIComponent(`created_at_i>=${a.getTime() / 1000},created_at_i<${b.getTime() / 1000}`)}`).catch(() => null);
    counts.push({ month: month(a), value: Number(r?.nbHits ?? 0) });
  }));
  counts.sort((x, y) => x.month.localeCompare(y.month));
  return { top_stories: stories.slice(0, 10), launches: stories.filter(s => s.kind !== "story").slice(0, 5), monthly_story_mentions: counts, mention_jumps: inflections(counts, 3) };
}
async function github(handle: string) {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(handle)) return null;
  const u = await getJson(`https://api.github.com/users/${handle}`); if (!u?.login) return null;
  const r = await getJson(`https://api.github.com/search/repositories?q=${encodeURIComponent(`user:${u.login}`)}&sort=stars&order=desc&per_page=5`);
  return { handle: u.login, type: u.type ?? null, created_at: String(u.created_at ?? "").slice(0, 10), public_repos: u.public_repos ?? null, followers: u.followers ?? null,
    top_repos: ((r?.items ?? []) as any[]).map(x => ({ name: x.full_name, stars: x.stargazers_count, created_at: String(x.created_at ?? "").slice(0, 10), url: x.html_url, description: x.description ?? null })) };
}
async function news(name: string) {
  const r = await getJson(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${name}"`)}&mode=artlist&maxrecords=15&sort=hybridrel&format=json&timespan=3months`, 6 * 3600_000);
  return ((r?.articles ?? []) as any[]).map(a => ({ date: `${String(a.seendate ?? "").slice(0, 4)}-${String(a.seendate ?? "").slice(4, 6)}-${String(a.seendate ?? "").slice(6, 8)}`, title: a.title, source: a.domain, url: a.url }));
}
async function wayback(domain: string) {
  const r = await getJson(`https://archive.org/wayback/available?url=${encodeURIComponent(domain)}&timestamp=19960101`, 7 * 86_400_000);
  const s = r?.archived_snapshots?.closest; if (!s?.timestamp) return null;
  const t = String(s.timestamp); return { first_capture: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`, url: s.url };
}

export async function companyGrowthSignals(q: any = {}) {
  const name = clean(q.company ?? q.name ?? q.q);
  if (name.length < 2 || name.length > 60) throw Object.assign(new Error("company is required, e.g. company=Lovable&domain=lovable.dev&github=lovable-dev"), { status: 400 });
  const domain = clean(q.domain).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const months = Math.min(Math.max(Number(q.months) || 24, 6), 36);
  const gh = clean(q.github) || (domain ? domain.split(".")[0] : name.toLowerCase().replace(/[^a-z0-9-]/g, ""));
  const status: Record<string, string> = {};
  const safe = async <T>(k: string, f: () => Promise<T>): Promise<T | null> => { try { const v = await f(); status[k] = "ok"; return v; } catch (e) { status[k] = `error: ${(e as Error).message}`; return null; } };
  const [w, h, g, n, wb] = await Promise.all([
    safe("wikipedia", () => wiki(name, clean(q.wikipedia), months, domain)), safe("hacker_news", () => hn(name, months, domain)),
    safe("github", () => github(gh)), safe("news_gdelt", () => news(name)), domain ? safe("wayback", () => wayback(domain)) : Promise.resolve(null),
  ]);
  const events: { date: string; channel: string; title: string; url?: string | null; metric?: string }[] = [];
  if (wb) events.push({ date: wb.first_capture, channel: "site", title: `${domain} first archived by the Wayback Machine`, url: wb.url });
  if (g) { if (g.created_at) events.push({ date: g.created_at, channel: "github", title: `GitHub account ${g.handle} created` });
    for (const r of g.top_repos) events.push({ date: r.created_at, channel: "github", title: `Repo ${r.name} created`, url: r.url, metric: `${r.stars} stars today` }); }
  for (const s of h?.top_stories ?? []) events.push({ date: s.date, channel: s.kind === "story" ? "hacker_news" : s.kind, title: s.title, url: s.hn_url, metric: `${s.points} points, ${s.comments} comments` });
  for (const a of n ?? []) events.push({ date: a.date, channel: "news", title: a.title, url: a.url, metric: a.source });
  events.sort((a, b) => a.date.localeCompare(b.date));
  const jumps = [...((w as any)?.attention_jumps ?? []), ...(h?.mention_jumps ?? [])].map(j => j.month);
  const infl = [...new Set(jumps)].sort().map(m => ({ month: m, wikipedia: (w as any)?.attention_jumps?.find((j: any) => j.month === m) ?? null, hacker_news: h?.mention_jumps.find(j => j.month === m) ?? null }));
  return {
    company: name, domain: domain || null, window_months: months,
    attention_jumps: aroundInflections(infl, events),
    timeline: events,
    wikipedia: w, hacker_news: h, github: g, recent_news: n, site: wb,
    sources_status: status,
    not_included: "Ads (Meta/Google/TikTok/LinkedIn libraries), traffic estimates and backlinks are third-party data we do not resell. Check the advertiser's pages in the public ad libraries yourself.",
    how_to_use: "Read attention_jumps: each month where Wikipedia views or Hacker News mentions jumped, with the launches, posts, repos and news from that month and the one before. Those dated moves are the candidates for 'what worked'. Check that wikipedia.article and the GitHub handle are the right company (pass wikipedia= and github= to fix).",
    sources: ["Wikimedia pageviews API", "Hacker News Algolia API", "GitHub REST API", "GDELT DOC 2.0 API", "Internet Archive Wayback availability API"],
    as_of: new Date().toISOString(), disclaimer: "Information and analytics only — public signals, not internal company data; not investment advice.",
  };
}
