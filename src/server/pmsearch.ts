/**
 * Polymarket markets & events search (04/11; rebuilt from the 03/11 48-h report — BlockRun sells the same at US$0.0085,
 * 112 buyers across the two routes). Source: Polymarket's public Gamma API, already used by polymarket_top.
 *  - polymarket_markets : text search over the ~500 most active open markets, tag, closing window, min liquidity;
 *    YES price, best bid/ask, spread, volume, liquidity, end date.
 *  - polymarket_events  : events (a question family, e.g. "Fed decision in December") with their top outcomes,
 *    volume and open interest.
 * Information only — not investment advice.
 */
import { UA } from "../ingest/http.js";

const G = "https://gamma-api.polymarket.com";
const memo = new Map<string, { at: number; v: any }>();
export const _pm = { reset() { memo.clear(); } };
async function get(url: string, ttl: number) {
  const c = memo.get(url); if (c && Date.now() - c.at < ttl) return c.v;
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw Object.assign(new Error(`gamma-api.polymarket.com ${res.status}`), { status: 502 });
    const v = await res.json(); memo.set(url, { at: Date.now(), v }); return v;
  } catch (e) { if (c) return c.v; throw e; }
}
const num = (x: any) => x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x);
const r = (x: number | null, d = 4) => x == null ? null : Math.round(x * 10 ** d) / 10 ** d;
const yesOf = (m: any) => { try { const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; return p ? num(p[0]) : null; } catch { return null; } };
async function tagId(slug?: string) { if (!slug) return null; const t = await get(`${G}/tags/slug/${encodeURIComponent(slug)}`, 86_400_000).catch(() => null); return t?.id != null ? String(t.id) : undefined; }
const words = (s: string) => String(s ?? "").toLowerCase().split(/[^a-z0-9$%.]+/).filter(w => w.length > 1);

/** Pure: Gamma market row → our shape. Exported for tests. */
export function marketOut(m: any) {
  const bid = num(m.bestBid), ask = num(m.bestAsk);
  return { id: String(m.id), slug: m.slug ?? null, question: m.question ?? null, yes_prob: r(yesOf(m)), best_bid: bid, best_ask: ask, spread: bid != null && ask != null ? r(ask - bid) : null,
    change_24h: r(num(m.oneDayPriceChange)), volume_24h_usd: num(m.volume24hr) != null ? Math.round(Number(m.volume24hr)) : null, volume_total_usd: num(m.volumeNum ?? m.volume) != null ? Math.round(Number(m.volumeNum ?? m.volume)) : null,
    liquidity_usd: num(m.liquidityNum ?? m.liquidity) != null ? Math.round(Number(m.liquidityNum ?? m.liquidity)) : null, end_date: m.endDate ?? null, url: m.slug ? `https://polymarket.com/market/${m.slug}` : null };
}
/** Pure: filter + rank by text match (all query words must appear), then by 24 h volume. Exported for tests. */
export function searchMarkets(rows: any[], q: { text?: string; ends_within_days?: number; min_liquidity?: number }, now = Date.now()) {
  const qw = words(q.text ?? "");
  return rows.map(marketOut).filter(m => {
    if (qw.length) { const w = new Set(words(m.question ?? "")); if (!qw.every(x => w.has(x) || [...w].some(y => y.startsWith(x)))) return false; }
    if (q.ends_within_days != null && m.end_date) { const d = (Date.parse(m.end_date) - now) / 86_400_000; if (!(d >= 0 && d <= q.ends_within_days)) return false; }
    if (q.min_liquidity != null && (m.liquidity_usd ?? 0) < q.min_liquidity) return false;
    return true;
  }).sort((a, b) => (b.volume_24h_usd ?? 0) - (a.volume_24h_usd ?? 0));
}

export async function polymarketMarkets(a: any = {}) {
  const tid = await tagId(a.tag ? String(a.tag) : undefined);
  if (tid === undefined) return { count: 0, items: [], note: `unknown Polymarket tag "${a.tag}" (use a Gamma tag slug such as crypto, politics, sports)`, disclaimer: "Information only — not investment advice." };
  const pages = await Promise.all([0, 1].map(p => get(`${G}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=250&offset=${p * 250}${tid ? `&tag_id=${tid}&related_tags=true` : ""}`, 120_000)));
  const rows = pages.flat().filter(Boolean);
  const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 100);
  const items = searchMarkets(rows, { text: a.q ? String(a.q).slice(0, 120) : undefined, ends_within_days: a.ends_within_days != null ? Number(a.ends_within_days) : undefined, min_liquidity: a.min_liquidity != null ? Number(a.min_liquidity) : undefined });
  return { query: a.q ?? null, tag: a.tag ?? null, searched: rows.length, count: Math.min(items.length, limit), items: items.slice(0, limit),
    note: "Searches the ~500 most active open markets. yes_prob = last YES price; spread = best ask − best bid.", sources: ["Polymarket Gamma API (public)"], as_of: new Date().toISOString(), disclaimer: "Information only — not investment advice." };
}

/** Pure: Gamma event row → our shape with its top outcomes. Exported for tests. */
export function eventOut(e: any, top = 5) {
  const ms = (e.markets ?? []).filter((m: any) => m && m.active !== false && m.closed !== true).map(marketOut).sort((x: any, y: any) => (y.yes_prob ?? 0) - (x.yes_prob ?? 0));
  return { id: String(e.id), slug: e.slug ?? null, title: e.title ?? null, end_date: e.endDate ?? null, volume_24h_usd: num(e.volume24hr) != null ? Math.round(Number(e.volume24hr)) : null,
    volume_total_usd: num(e.volume) != null ? Math.round(Number(e.volume)) : null, open_interest_usd: num(e.openInterest) != null ? Math.round(Number(e.openInterest)) : null,
    liquidity_usd: num(e.liquidity) != null ? Math.round(Number(e.liquidity)) : null, markets: ms.length,
    top_outcomes: ms.slice(0, top).map((m: any) => ({ question: m.question, yes_prob: m.yes_prob, volume_24h_usd: m.volume_24h_usd })), url: e.slug ? `https://polymarket.com/event/${e.slug}` : null };
}
export async function polymarketEvents(a: any = {}) {
  const tid = await tagId(a.tag ? String(a.tag) : undefined);
  if (tid === undefined) return { count: 0, items: [], note: `unknown Polymarket tag "${a.tag}"`, disclaimer: "Information only — not investment advice." };
  const rows = await get(`${G}/events?active=true&closed=false&order=volume24hr&ascending=false&limit=200${tid ? `&tag_id=${tid}&related_tags=true` : ""}`, 120_000);
  const qw = words(a.q ?? "");
  const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
  const items = (Array.isArray(rows) ? rows : []).filter((e: any) => !qw.length || qw.every(x => words(e.title ?? "").some(y => y.startsWith(x)))).map((e: any) => eventOut(e));
  return { query: a.q ?? null, tag: a.tag ?? null, count: Math.min(items.length, limit), items: items.slice(0, limit), sources: ["Polymarket Gamma API (public)"], as_of: new Date().toISOString(), disclaimer: "Information only — not investment advice." };
}
