/**
 * Topic demand (Renato 02/11, "YouTube/Google/IA são buscadores"): how much attention a subject is getting, from a
 * PRIMARY, official, free source — Wikimedia's pageviews API (human traffic to the subject's Wikipedia article, daily).
 * Content, SEO and research agents use it to decide what to cover and to see a topic heating up or cooling down.
 * No LLM, no scraping, no resale. Up to 5 topics per call, any Wikipedia language.
 */
import { UA } from "../ingest/http.js";

const memo = new Map<string, { at: number; v: any }>();
async function cached<T>(k: string, ttl: number, f: () => Promise<T>): Promise<T> {
  const c = memo.get(k); if (c && Date.now() - c.at < ttl) return c.v as T;
  try { const v = await f(); memo.set(k, { at: Date.now(), v }); return v; } catch (e) { if (c) return c.v as T; throw e; }
}
export const _topics = { reset() { memo.clear(); } };
async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} ${res.status}`), { status: 502 });
  return res.json();
}
const ymd = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, "");
const mean = (a: number[]) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
const pct = (a: number | null, b: number | null) => a == null || b == null || b === 0 ? null : Math.round((a / b - 1) * 1000) / 10;
const r0 = (x: number | null) => x == null ? null : Math.round(x);

/** Pure: daily Wikimedia items (oldest first) → demand summary. Exported for tests. */
export function demandFrom(items: { timestamp: string; views: number }[]) {
  const v = items.map(i => Number(i.views) || 0);
  const day = (i: { timestamp: string }) => `${i.timestamp.slice(0, 4)}-${i.timestamp.slice(4, 6)}-${i.timestamp.slice(6, 8)}`;
  const last7 = v.slice(-7), prev7 = v.slice(-14, -7), last30 = v.slice(-30), prev30 = v.slice(-60, -30);
  const a7 = mean(last7), p7 = mean(prev7), a30 = mean(last30), p30 = prev30.length >= 20 ? mean(prev30) : null;
  let peak = -1, pi = -1; v.forEach((x, i) => { if (x > peak) { peak = x; pi = i; } });
  const trend = a7 == null || p7 == null ? "unknown" : (pct(a7, p7)! >= 15 ? "rising" : pct(a7, p7)! <= -15 ? "falling" : "steady");
  return {
    views_last_day: v.length ? v[v.length - 1] : null, last_day: items.length ? day(items[items.length - 1]) : null,
    avg_7d: r0(a7), avg_prev_7d: r0(p7), change_7d_pct: pct(a7, p7),
    avg_30d: r0(a30), avg_prev_30d: r0(p30), change_30d_pct: pct(a30, p30),
    trend, peak_60d: pi >= 0 ? { date: day(items[pi]), views: peak } : null,
    daily_30d: items.slice(-30).map(i => ({ date: day(i), views: Number(i.views) || 0 })),
  };
}

async function oneTopic(topic: string, lang: string) {
  return cached(`t:${lang}:${topic.toLowerCase()}`, 3 * 3600_000, async () => {
    const s = await getJson(`https://${lang}.wikipedia.org/w/rest.php/v1/search/title?q=${encodeURIComponent(topic)}&limit=1`);
    const page = s?.pages?.[0]; if (!page?.key) return { topic, found: false };
    const end = new Date(Date.now() - 86_400_000), start = new Date(end.getTime() - 59 * 86_400_000);
    const pv = await getJson(`https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia.org/all-access/user/${encodeURIComponent(page.key)}/daily/${ymd(start)}/${ymd(end)}`);
    return { topic, found: true, article: page.title, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.key)}`, ...demandFrom(pv?.items ?? []) };
  });
}

export async function topicDemand(q: any = {}) {
  const raw = String(q.topics ?? q.topic ?? "Artificial intelligence");
  const topics = [...new Set(raw.split(",").map(t => t.trim()).filter(Boolean))].slice(0, 5);
  const lang = /^[a-z]{2,3}$/.test(String(q.lang ?? "")) ? String(q.lang) : "en";
  const items = await Promise.all(topics.map(t => oneTopic(t, lang).catch(e => ({ topic: t, found: false, error: String((e as Error).message) }))));
  const ranked = [...items].sort((a: any, b: any) => (b.avg_7d ?? -1) - (a.avg_7d ?? -1));
  return { lang, n: items.length, items: ranked,
    method: "Human pageviews (agents excluded) of the topic's Wikipedia article, daily, last 60 days. trend: rising/falling if the 7-day mean moved ≥15% vs the previous 7 days.",
    sources: ["Wikimedia REST API — pageviews per article (wikimedia.org/api/rest_v1)", `${lang}.wikipedia.org search`],
    as_of: new Date().toISOString(), disclaimer: "Information and analytics only — not investment advice." };
}
