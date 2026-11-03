/**
 * YouTube analytics (Renato 03/11 — "1of10 / NexLev"): DERIVED metrics from the official YouTube Data API v3.
 *  - youtube_outliers : a channel's recent uploads ranked by views ÷ the channel's median (same format: long-form vs
 *    Shorts) — the videos that did 5×, 10×, 100× the channel's normal.
 *  - youtube_channel_growth : subscribers / views / uploads per day from OUR OWN daily snapshots (the API only gives
 *    the number now), with 7-day and 30-day change — history starts the first day a channel is looked up.
 * Policy (YouTube API Services, Derived Metrics Policy, "Analytics & Reporting" use case): derived metrics are labelled
 * as ours and kept apart from API data; only statistics are stored (≤ 36 months) — titles are never stored, they are
 * fetched live; no raw API data is resold. Not affiliated with YouTube. Key: env YOUTUBE_API_KEY.
 */
import { getDb } from "../store/db.js";
import { UA } from "../ingest/http.js";

const API = "https://www.googleapis.com/youtube/v3";
const memo = new Map<string, { at: number; v: any }>();
export const _yt = { reset() { memo.clear(); } };
const POLICY = "Derived metrics (multiple_of_median, median_views, views_per_day, growth) are computed by Degenscan Intel from YouTube Data API statistics; they are not YouTube metrics. Not affiliated with or endorsed by YouTube.";

function key() { const k = process.env.YOUTUBE_API_KEY; if (!k) throw Object.assign(new Error("YouTube data is not configured on this deployment yet"), { status: 503 }); return k; }
async function yt(path: string, params: Record<string, string>) {
  const u = new URL(`${API}/${path}`); for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v); u.searchParams.set("key", key());
  const res = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw Object.assign(new Error(res.status === 403 ? "YouTube API quota or key error" : `YouTube API ${res.status}`), { status: 502 });
  return res.json() as Promise<any>;
}
function ensure() { getDb().exec("CREATE TABLE IF NOT EXISTS yt_snap (channel_id TEXT NOT NULL, day TEXT NOT NULL, subs INTEGER, views INTEGER, videos INTEGER, PRIMARY KEY (channel_id, day))"); }
function snap(c: any) {
  ensure(); const st = c?.statistics ?? {};
  getDb().prepare("INSERT INTO yt_snap (channel_id, day, subs, views, videos) VALUES (?,?,?,?,?) ON CONFLICT(channel_id, day) DO UPDATE SET subs = excluded.subs, views = excluded.views, videos = excluded.videos")
    .run(c.id, new Date().toISOString().slice(0, 10), st.hiddenSubscriberCount ? null : num(st.subscriberCount), num(st.viewCount), num(st.videoCount));
}
const num = (x: any) => x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x);

/** Pure: "@handle", "UC…", a channel URL → API selector. Exported for tests. */
export function channelSelector(raw: string): { forHandle: string } | { id: string } {
  const s = String(raw ?? "").trim(); if (!s) throw Object.assign(new Error("channel required: @handle, channel id (UC…) or channel URL"), { status: 400 });
  const id = s.match(/(UC[0-9A-Za-z_-]{22})/); if (id) return { id: id[1] };
  const h = s.match(/@([0-9A-Za-z._-]{3,100})/) ?? s.match(/^([0-9A-Za-z._-]{3,100})$/);
  if (h) return { forHandle: `@${h[1]}` };
  throw Object.assign(new Error("channel not understood: use @handle, UC… id or https://youtube.com/@handle"), { status: 400 });
}
/** Pure: ISO-8601 duration → seconds. Exported for tests. */
export function isoSeconds(d: string): number { const m = String(d ?? "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/); if (!m) return 0; return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0)); }
const median = (a: number[]) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Pure: videos.list items → outliers by format, each vs the median of its own format. Exported for tests. */
export function outliersFrom(items: any[], now = Date.now(), minAgeDays = 3) {
  const vids = (items ?? []).map((v: any) => {
    const secs = isoSeconds(v.contentDetails?.duration), age = Math.max(0, (now - Date.parse(v.snippet?.publishedAt ?? "")) / 86_400_000);
    return { id: v.id, url: `https://www.youtube.com/watch?v=${v.id}`, title: v.snippet?.title ?? null, published_at: v.snippet?.publishedAt ?? null, age_days: Math.round(age * 10) / 10,
      format: secs > 0 && secs <= 180 ? "short" : "long", duration_s: secs, views: num(v.statistics?.viewCount) ?? 0, likes: num(v.statistics?.likeCount), comments: num(v.statistics?.commentCount) };
  }).filter(v => v.id && v.published_at);
  const out: any = {};
  for (const f of ["long", "short"] as const) {
    const pool = vids.filter(v => v.format === f), mature = pool.filter(v => v.age_days >= minAgeDays), med = median(mature.map(v => v.views));
    out[f] = { n: pool.length, median_views: med != null ? Math.round(med) : null,
      items: pool.map(v => ({ ...v, multiple_of_median: med ? Math.round(v.views / med * 100) / 100 : null, views_per_day: v.age_days > 0 ? Math.round(v.views / Math.max(v.age_days, 1)) : v.views, too_recent: v.age_days < minAgeDays }))
        .sort((a, b) => (b.multiple_of_median ?? 0) - (a.multiple_of_median ?? 0)) };
  }
  return out;
}

async function channel(raw: string) {
  key();
  const sel = channelSelector(raw); const ck = `ch:${JSON.stringify(sel)}`; const c = memo.get(ck);
  if (c && Date.now() - c.at < 3600_000) return c.v;
  const j = await yt("channels", { part: "snippet,statistics,contentDetails", ...(sel as any) });
  const ch = j?.items?.[0]; if (!ch) throw Object.assign(new Error("channel not found"), { status: 404 });
  snap(ch); memo.set(ck, { at: Date.now(), v: ch }); return ch;
}
const channelOut = (ch: any) => ({ id: ch.id, title: ch.snippet?.title ?? null, handle: ch.snippet?.customUrl ?? null, url: `https://www.youtube.com/channel/${ch.id}`,
  subscribers: ch.statistics?.hiddenSubscriberCount ? null : num(ch.statistics?.subscriberCount), total_views: num(ch.statistics?.viewCount), videos: num(ch.statistics?.videoCount) });

export async function youtubeOutliers(q: any = {}) {
  const ch = await channel(String(q.channel ?? q.handle ?? q.id ?? ""));
  const n = Math.min(Math.max(Number(q.videos) || 50, 10), 50);
  const ck = `up:${ch.id}:${n}`; let items: any[]; const c = memo.get(ck);
  if (c && Date.now() - c.at < 3600_000) items = c.v;
  else {
    const pl = await yt("playlistItems", { part: "contentDetails", playlistId: ch.contentDetails?.relatedPlaylists?.uploads ?? "", maxResults: String(n) });
    const ids = (pl?.items ?? []).map((i: any) => i.contentDetails?.videoId).filter(Boolean);
    items = ids.length ? ((await yt("videos", { part: "snippet,statistics,contentDetails", id: ids.join(",") }))?.items ?? []) : [];
    memo.set(ck, { at: Date.now(), v: items });
  }
  const o = outliersFrom(items);
  const fmt = ["long", "short"].includes(String(q.format)) ? String(q.format) : "all";
  const top = Math.min(Math.max(Number(q.limit) || 15, 1), 50);
  const pick = (f: "long" | "short") => ({ ...o[f], items: o[f].items.slice(0, top) });
  return { channel: channelOut(ch), analysed_uploads: items.length, method: "Each upload's views ÷ the median views of the channel's recent uploads of the same format (long-form vs Shorts ≤ 180 s); uploads younger than 3 days are excluded from the median and flagged too_recent.",
    ...(fmt !== "short" ? { long: pick("long") } : {}), ...(fmt !== "long" ? { shorts: pick("short") } : {}),
    policy: POLICY, sources: ["YouTube Data API v3 (channels, playlistItems, videos)"], as_of: new Date().toISOString(), disclaimer: "Information and analytics only." };
}

/** Pure: daily snapshots (oldest first) → growth summary. Exported for tests. */
export function growthFrom(rows: { day: string; subs: number | null; views: number | null; videos: number | null }[]) {
  const last = rows[rows.length - 1]; const at = (d: number) => { const t = new Date(Date.parse(last.day) - d * 86_400_000).toISOString().slice(0, 10); return [...rows].reverse().find(r => r.day <= t) ?? null; };
  const ch = (k: "subs" | "views" | "videos", d: number) => { const p = at(d); if (!p || p.day === last.day || last[k] == null || p[k] == null) return null; return { from_day: p.day, abs: (last[k] as number) - (p[k] as number), pct: p[k] ? Math.round(((last[k] as number) / (p[k] as number) - 1) * 1000) / 10 : null }; };
  return { history_days: rows.length, first_day: rows[0]?.day ?? null, last_day: last?.day ?? null, subscribers: last?.subs ?? null, total_views: last?.views ?? null, videos: last?.videos ?? null,
    change_7d: { subscribers: ch("subs", 7), views: ch("views", 7), videos: ch("videos", 7) }, change_30d: { subscribers: ch("subs", 30), views: ch("views", 30), videos: ch("videos", 30) },
    daily: rows.slice(-60) };
}
export async function youtubeGrowth(q: any = {}) {
  const ch = await channel(String(q.channel ?? q.handle ?? q.id ?? ""));
  ensure(); const rows = getDb().prepare("SELECT day, subs, views, videos FROM yt_snap WHERE channel_id = ? ORDER BY day").all(ch.id) as any[];
  return { channel: channelOut(ch), ...growthFrom(rows),
    note: rows.length < 8 ? "Tracking started on the first lookup of this channel; 7-day change appears after a week of daily snapshots, 30-day after a month." : undefined,
    method: "Daily snapshots of the channel's public statistics taken by Degenscan Intel (every channel looked up is tracked for 90 days).", policy: POLICY,
    sources: ["YouTube Data API v3 (channels)", "Degenscan Intel daily snapshots"], as_of: new Date().toISOString(), disclaimer: "Information and analytics only." };
}

/** Daily refresh of every channel looked up in the last 90 days: 1 API unit per 50 channels. */
export function startYoutubeTracker() {
  if (!process.env.YOUTUBE_API_KEY) return;
  const run = async () => {
    try {
      ensure(); const since = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10), today = new Date().toISOString().slice(0, 10);
      const ids = (getDb().prepare("SELECT channel_id FROM yt_snap GROUP BY channel_id HAVING MIN(day) >= ? AND MAX(day) < ? LIMIT 2000").all(since, today) as any[]).map(r => r.channel_id);
      for (let i = 0; i < ids.length; i += 50) { const j = await yt("channels", { part: "statistics", id: ids.slice(i, i + 50).join(",") }); for (const c of j?.items ?? []) snap(c); }
    } catch { /* retry next cycle */ }
  };
  setTimeout(run, 60_000).unref?.(); setInterval(run, 6 * 3600_000).unref?.();
}
