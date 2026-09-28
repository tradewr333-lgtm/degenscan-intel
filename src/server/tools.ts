import { z } from "zod";
import { queryEvents, impactsForAsset, sourcesStatus, getEvent } from "../store/db.js";
import { neighborhood } from "../graph/graph.js";
import { loadUniverse } from "../universe/index.js";
import { openVenues } from "../engine/sessions.js";
import { CONNECTORS } from "../ingest/registry.js";
import { PRICES } from "./pricing.js";

/** Parse "4h", "30m", "2d" or ISO into ISO. */
export function parseSince(s: string | undefined, def = "4h"): string {
  const v = (s ?? def).trim();
  const m = /^(\d+)\s*([mhd])$/i.exec(v);
  if (m) {
    const n = Number(m[1]), unit = m[2].toLowerCase();
    const ms = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * ms).toISOString();
  }
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`invalid since: ${s}`);
  return d.toISOString();
}

export const EventsSinceArgs = z.object({
  since: z.string().default("4h").describe('Window start: "30m", "4h", "2d" or ISO-8601. Past values work identically (backtesting).'),
  until: z.string().optional().describe("Window end (ISO-8601). Default now."),
  universe: z.array(z.string()).optional().describe("Asset ids to filter impacts by, e.g. [\"NVDA\",\"BTC\",\"CL\"]. Omit for all."),
  kinds: z.array(z.string()).optional().describe('Event kinds or prefixes: ["reg.", "corp.8k", "nat.quake"].'),
  min_severity: z.number().min(0).max(1).optional().describe("Drop events below this severity (0..1). 0.5 keeps market-moving events only."),
  min_confidence: z.number().min(0).max(1).optional().describe("Min impact confidence (0..1) for the universe filter. 0.4 is a sensible threshold for acting."),
  q: z.string().optional().describe('Full-text query over title/summary (FTS5 syntax), e.g. "tariff OR sanction".'),
  limit: z.number().int().min(1).max(200).default(50).describe("Max events returned (1..200)."),
});
export type EventsSinceArgs = z.infer<typeof EventsSinceArgs>;

export function eventsSince(a: EventsSinceArgs) {
  const since = parseSince(a.since);
  const events = queryEvents({ since, until: a.until ? parseSince(a.until) : undefined, kinds: a.kinds, assets: a.universe, min_severity: a.min_severity, min_confidence: a.min_confidence, q: a.q, limit: a.limit });
  return { since, until: a.until ?? new Date().toISOString(), count: events.length, universe_version: loadUniverse().version, events };
}

export const ImpactForArgs = z.object({
  asset_id: z.string().describe("Universe asset id (case-insensitive), e.g. NVDA, BTC, CL, US10Y, SPX. Call `universe` to list ids."),
  since: z.string().default("24h").describe('Lookback window: "1h", "24h", "7d" or ISO-8601. Default 24h.'),
  limit: z.number().int().min(1).max(200).default(50).describe("Max source events returned with the aggregate."),
});
export function impactFor(a: z.infer<typeof ImpactForArgs>) {
  const asset = loadUniverse().assets.find(x => x.id === a.asset_id.toUpperCase());
  if (!asset) throw new Error(`unknown asset_id ${a.asset_id}; call universe`);
  return { asset, ...impactsForAsset(asset.id, parseSince(a.since), a.limit) };
}

export const ExposureGraphArgs = z.object({
  asset_id: z.string().describe("Universe asset id, e.g. NVDA, TSM, MSTR, GC. Call `universe` to list ids."),
  depth: z.number().int().min(1).max(3).default(2).describe("Hops from the asset: 1 = direct suppliers/customers/regulators, 2 = second order (default), 3 = wide."),
});
export function exposureGraph(a: z.infer<typeof ExposureGraphArgs>) {
  const asset = loadUniverse().assets.find(x => x.id === a.asset_id.toUpperCase());
  if (!asset) throw new Error(`unknown asset_id ${a.asset_id}`);
  return { asset, ...neighborhood(asset.id, a.depth) };
}

export function universe() {
  const u = loadUniverse();
  return { version: u.version, generated_at: u.generated_at, count: u.assets.length, assets: u.assets.map(a => ({ id: a.id, name: a.name, class: a.class, venue: a.venue, tags: a.tags })) };
}

export function sources() {
  const status = sourcesStatus() as any[];
  return {
    count: CONNECTORS.length,
    sources: CONNECTORS.map(c => ({ id: c.id, name: c.name, tier: c.tier, cadence_s: c.cadence_s, url: c.url, key_env: c.key_env, needs_key: !!c.key_env && !process.env[c.key_env], ...(status.find(s => s.source_id === c.id) ?? {}) })),
  };
}

/** Regime snapshot: what's open, last-24h event pressure by class, biggest impacts, prediction-market context. */
export function regimeSnapshot() {
  const since = parseSince("24h");
  const events = queryEvents({ since, limit: 500 });
  const byKind: Record<string, number> = {};
  const pressure: Record<string, { n: number; net: number }> = {};
  for (const e of events) {
    const k = e.kind.split(".")[0]; byKind[k] = (byKind[k] ?? 0) + 1;
    for (const i of e.impacts) { const p = pressure[i.asset_id] ?? (pressure[i.asset_id] = { n: 0, net: 0 }); p.n++; p.net += i.direction * i.confidence; }
  }
  const ranked = Object.entries(pressure).map(([asset_id, p]) => ({ asset_id, n: p.n, net: Math.round(p.net * 1000) / 1000 })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net)).slice(0, 25);
  const predictions = events.filter(e => e.kind === "mkt.prediction_shift").slice(0, 15).map(e => ({ title: e.title, ...e.meta }));
  const top = events.filter(e => e.severity >= 0.6).slice(0, 10).map(e => ({ id: e.id, ts_event: e.ts_event, kind: e.kind, title: e.title, top_impacts: e.impacts.slice(0, 3) }));
  return { at: new Date().toISOString(), venues_open: openVenues(), events_24h: events.length, by_class: byKind, pressure: ranked, high_severity: top, prediction_markets: predictions, universe_version: loadUniverse().version };
}

export function explain(eventId: string) {
  const e = getEvent(eventId);
  if (!e) throw new Error("event not found");
  // v0: deterministic explanation. Set EXPLAIN_LLM=1 + ANTHROPIC_API_KEY to upgrade to a model-written rationale later.
  const lines = e.impacts.slice(0, 8).map(i => `• ${i.asset_id}: ${i.direction > 0 ? "▲" : i.direction < 0 ? "▼" : "◆"} conf ${i.confidence} — ${i.rationale}`);
  return { event: e, explanation: `${e.title}\n${e.summary}\nSource: ${e.source.name} (${e.source.tier}), latency ${Math.round(e.latency_ms / 1000)}s, corroborated by ${e.corroboration.count} source(s).\n${lines.join("\n")}` };
}

export const TOOL_DOCS = Object.entries(PRICES).map(([tool, usd]) => ({ tool, price_usd: usd }));

/* ───────────────────────── Prediction-market context ───────────────────────── */

const STOP = new Set(["will", "the", "be", "by", "in", "on", "of", "to", "a", "an", "and", "or", "for", "at", "before", "after", "than", "more", "less", "above", "below", "than", "does", "do", "is", "are", "this", "that", "with", "from", "into", "over", "under", "end", "year", "month", "week", "day", "2025", "2026", "2027", "who", "what", "which", "win", "reach", "hit", "close", "price", "yes", "no", "vs", "vs.", "market", "odds", "happen", "announce", "announced"]);
/** Keywords from a market question → FTS5 OR-query over our event titles/summaries. */
export function questionTerms(q: string): string[] {
  const words = q.toLowerCase().replace(/[^a-z0-9$%.\- ]/g, " ").split(/\s+/).map(w => w.replace(/^[.\-]+|[.\-]+$/g, "")).filter(w => w.length >= 3 && !STOP.has(w));
  return [...new Set(words)].slice(0, 8);
}

export const PolymarketContextArgs = z.object({
  market: z.string().describe("Polymarket market id, slug, or the question text itself (e.g. \"Fed rate cut in October?\"). Slugs/ids are resolved via the public Gamma API; text is searched."),
  since: z.string().default("48h").describe('Lookback window for related events: "6h", "48h", "7d". Default 48h.'),
  limit: z.number().int().min(1).max(50).default(15).describe("Max related events."),
});
export type PolymarketContextArgs = z.infer<typeof PolymarketContextArgs>;

/** Resolve a Polymarket market (public Gamma API, no key) and attach the events in our feed that bear on it.
 *  Direction heuristic: for each related event we report its per-asset impacts and a coarse `lean` (supportive / against / unclear)
 *  derived from event kind + the question's polarity words; the agent combines this with the market's current odds. */
export async function polymarketContext(a: PolymarketContextArgs) {
  const { fetchJson } = await import("../ingest/http.js");
  const isId = /^\d+$/.test(a.market); const isSlug = /^[a-z0-9-]+$/.test(a.market) && a.market.includes("-");
  let markets: any[] = [];
  try {
    if (isId) markets = [await fetchJson<any>(`https://gamma-api.polymarket.com/markets/${a.market}`, { timeoutMs: 8000 })];
    else if (isSlug) markets = await fetchJson<any[]>(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(a.market)}`, { timeoutMs: 8000 });
    else {
      // Real text search: public-search returns events → markets. Pick the open market whose question overlaps the query most.
      const r = await fetchJson<any>(`https://gamma-api.polymarket.com/public-search?q=${encodeURIComponent(a.market)}&limit_per_type=5`, { timeoutMs: 8000 });
      const qt = new Set(questionTerms(a.market));
      const cands: any[] = (r?.events ?? []).flatMap((ev: any) => (ev.markets ?? []).filter((m: any) => m.active !== false && m.closed !== true));
      const score = (m: any) => questionTerms(m.question ?? "").filter(t => qt.has(t)).length;
      markets = cands.map(m => ({ m, s: score(m) })).filter(x => x.s > 0).sort((x, y) => y.s - x.s || Number(y.m.volume ?? 0) - Number(x.m.volume ?? 0)).map(x => x.m);
    }
  } catch { markets = []; }
  const m = markets.find(Boolean);
  const question: string = m?.question ?? a.market;
  const safe = (s: unknown) => { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return undefined; } };
  const outcomes: string[] = safe(m?.outcomes) ?? ["Yes", "No"]; const prices: number[] = (safe(m?.outcomePrices) ?? []).map(Number);
  const terms = questionTerms(question);
  const since = parseSince(a.since, "48h");
  const events = terms.length ? queryEvents({ since, q: terms.map(t => `"${t.replace(/"/g, "")}"`).join(" OR "), limit: a.limit }) : [];
  // score relevance: how many question terms appear in title+summary; keep primary/aggregator sources first
  const WEAK = /^(\d[\d.,k%$]*|january|february|march|april|may|june|july|august|september|october|november|december|q[1-4])$/;
  const strong = terms.filter(t => !WEAK.test(t));
  const minHits = terms.length >= 4 ? 2 : 1;
  // at least one strong (non-numeric, non-month) term must match, so "100k" or "december" alone never pull in noise
  const scored = events.map(e => { const hay = `${e.title} ${e.summary}`.toLowerCase(); const hits = terms.filter(t => hay.includes(t)).length; const strongHit = strong.some(t => hay.includes(t)); return { e, hits, strongHit }; })
    .filter(x => x.hits >= minHits && (x.strongHit || strong.length === 0)).sort((x, y) => y.hits - x.hits || y.e.severity - x.e.severity).slice(0, a.limit);
  const related = scored.map(({ e, hits }) => ({
    id: e.id, ts_event: e.ts_event, kind: e.kind, title: e.title, source: e.source.id, tier: e.source.tier, severity: e.severity, corroboration: e.corroboration.count,
    matched_terms: terms.filter(t => `${e.title} ${e.summary}`.toLowerCase().includes(t)), relevance: Math.round((hits / terms.length) * 100) / 100,
    impacts: e.impacts.slice(0, 5).map(i => ({ asset_id: i.asset_id, direction: i.direction, confidence: i.confidence })), raw_ref: e.raw_ref,
  }));
  return {
    market: m ? { id: m.id, slug: m.slug, question, outcomes, prices, yes_prob: prices[0] ?? null, change_24h: m.oneDayPriceChange != null ? Number(m.oneDayPriceChange) : null, volume_24h: m.volume24hr != null ? Number(m.volume24hr) : null, end_date: m.endDate, url: `https://polymarket.com/event/${m.slug ?? m.id}` } : { question, note: "market not resolved on Gamma API; showing feed events matching the question text" },
    query_terms: terms, since, n_related: related.length, related,
    how_to_use: "Compare the market's yes_prob with the recency, tier and severity of related primary-source events. A fresh primary event (SEC/Fed/agency, corroboration>=2) that the market has not repriced (small change_24h) is the signal. This is information, not a forecast.",
    universe_version: loadUniverse().version,
  };
}

/* ───────────────────────── Discovery-priced endpoints (v0.5): pulse, news, filings, calendar; premium brief ───────────────────────── */

/** $0.001 probe: what happened in the last hour, by event class, plus venues open. The obvious first call for a new agent. */
export function pulse() {
  const since = parseSince("1h");
  const events = queryEvents({ since, limit: 500 });
  const byClass: Record<string, number> = {};
  for (const e of events) { const k = e.kind.split(".")[0]; byClass[k] = (byClass[k] ?? 0) + 1; }
  const top = [...events].sort((a, b) => b.severity - a.severity).slice(0, 3).map(e => ({ id: e.id, kind: e.kind, title: e.title, severity: e.severity, top_impacts: e.impacts.slice(0, 3).map(i => `${i.asset_id}${i.direction > 0 ? "+" : i.direction < 0 ? "-" : "~"}`) }));
  return { at: new Date().toISOString(), window: "1h", events: events.length, by_class: byClass, high_severity: events.filter(e => e.severity >= 0.7).length, top, venues_open: openVenues(new Date()), universe_version: loadUniverse().version, next: "events_since for detail · brief/{asset} for a full pre-trade briefing" };
}

const MEDIA_KINDS = ["media.", "corp.press", "corp.earnings", "corp.guidance", "corp.mna", "corp.recall", "corp.lawsuit", "corp.halt", "crypto.hack", "crypto.listing", "crypto.outage"];
const FILING_KINDS = ["corp.8k", "corp.insider", "corp.activist", "corp.offering", "corp.bankruptcy"];
const POS = /\b(beat|beats|surge|surges|soar|soars|rally|rallies|record|upgrade|upgrades|approve|approved|approval|wins|win|gain|gains|jump|jumps|bullish|expand|expands|partnership|buyback|dividend|raises guidance|outperform)\b/i;
const NEG = /\b(miss|misses|plunge|plunges|fall|falls|drop|drops|slump|cut|cuts|downgrade|downgrades|probe|investigat\w+|lawsuit|sues|sued|recall|halt|halted|hack|hacked|exploit|breach|bankrupt\w*|default|sanction\w*|fine|fined|bearish|layoff\w*|delay\w*|warning|warns)\b/i;
/** Cheap deterministic headline sentiment: -1..1 from lexical hits, blended with the event's own directional impact on the asset. */
function headlineSentiment(title: string, summary: string, assetDir: number | undefined): number {
  const t = `${title} ${summary}`; let s = 0;
  if (POS.test(t)) s += 0.5; if (NEG.test(t)) s -= 0.5;
  if (assetDir != null) s = s * 0.5 + assetDir * 0.5;
  return Math.max(-1, Math.min(1, Math.round(s * 100) / 100));
}

export const NewsArgs = z.object({
  ticker: z.string().describe("Asset id, e.g. NVDA, BTC, MSTR. Call `universe` to list ids."),
  since: z.string().default("24h").describe('Window: "6h", "24h", "3d". Default 24h.'),
  limit: z.number().int().min(1).max(100).default(25),
});
/** Headlines that touch one asset in the window, with source tier, corroboration and a heuristic sentiment score. Links to originals; no article bodies. */
export function newsFor(a: z.infer<typeof NewsArgs>) {
  const id = a.ticker.toUpperCase(); const asset = loadUniverse().assets.find(x => x.id === id);
  if (!asset) throw new Error(`unknown asset_id ${a.ticker}`);
  const since = parseSince(a.since, "24h");
  const evs = queryEvents({ since, assets: [id], kinds: MEDIA_KINDS, limit: a.limit });
  const items = evs.map(e => { const imp = e.impacts.find(i => i.asset_id === id); return { id: e.id, ts: e.ts_event, kind: e.kind, title: e.title, source: e.source.id, tier: e.source.tier, corroboration: e.corroboration.count, sentiment: headlineSentiment(e.title, e.summary, imp?.direction), direction: imp?.direction ?? 0, confidence: imp?.confidence ?? 0, url: e.raw_ref }; });
  const avg = items.length ? Math.round((items.reduce((s, x) => s + x.sentiment, 0) / items.length) * 100) / 100 : 0;
  return { asset: { id, name: asset.name, class: asset.class }, since, count: items.length, sentiment_avg: avg, sentiment_label: avg > 0.2 ? "positive" : avg < -0.2 ? "negative" : "neutral", items, universe_version: loadUniverse().version };
}

export const FilingsArgs = z.object({
  ticker: z.string().describe("US equity id, e.g. NVDA, TSLA, COIN."),
  since: z.string().default("7d").describe('Window: "24h", "7d", "30d". Default 7d.'),
  forms: z.array(z.string()).optional().describe("Filter: 8k | insider (Form 4) | activist (13D/G) | offering (S-1/424B) | bankruptcy. Default all."),
  limit: z.number().int().min(1).max(100).default(25),
});
/** SEC filings (8-K by item, Form 4 insider, 13D/G activist, S-1 offerings) that touch one issuer, from EDGAR (public domain), with per-asset impact. */
export function filingsFor(a: z.infer<typeof FilingsArgs>) {
  const id = a.ticker.toUpperCase(); const asset = loadUniverse().assets.find(x => x.id === id);
  if (!asset) throw new Error(`unknown asset_id ${a.ticker}`);
  const map: Record<string, string> = { "8k": "corp.8k", insider: "corp.insider", activist: "corp.activist", offering: "corp.offering", bankruptcy: "corp.bankruptcy" };
  const kinds = a.forms?.length ? a.forms.map(f => map[f.toLowerCase()] ?? f) : FILING_KINDS;
  const since = parseSince(a.since, "7d");
  const evs = queryEvents({ since, assets: [id], kinds, limit: a.limit });
  return { asset: { id, name: asset.name, cik: (asset as any).cik ?? null }, since, count: evs.length,
    filings: evs.map(e => { const imp = e.impacts.find(i => i.asset_id === id); return { id: e.id, ts: e.ts_event, kind: e.kind, title: e.title, summary: e.summary.slice(0, 300), direction: imp?.direction ?? 0, confidence: imp?.confidence ?? 0, url: e.raw_ref, source: e.source.id }; }), universe_version: loadUniverse().version };
}

/** US macro calendar Q4-2026 (published schedules of BLS, BEA and the Federal Reserve; times ET). Verify against the issuer before trading around a print. */
const MACRO_2026Q4: { date: string; time_et: string; name: string; type: "fomc" | "cpi" | "jobs" | "pce" | "gdp" | "ppi" | "retail" | "jolts" | "minutes"; source: string }[] = [
  { date: "2026-10-02", time_et: "08:30", name: "Employment Situation (Nonfarm Payrolls)", type: "jobs", source: "bls.gov" },
  { date: "2026-10-07", time_et: "14:00", name: "FOMC Minutes", type: "minutes", source: "federalreserve.gov" },
  { date: "2026-10-14", time_et: "08:30", name: "Consumer Price Index (CPI)", type: "cpi", source: "bls.gov" },
  { date: "2026-10-15", time_et: "08:30", name: "Producer Price Index (PPI)", type: "ppi", source: "bls.gov" },
  { date: "2026-10-15", time_et: "08:30", name: "Advance Monthly Retail Sales", type: "retail", source: "census.gov" },
  { date: "2026-10-28", time_et: "14:00", name: "FOMC Rate Decision + Statement", type: "fomc", source: "federalreserve.gov" },
  { date: "2026-10-29", time_et: "08:30", name: "GDP Q3 (Advance)", type: "gdp", source: "bea.gov" },
  { date: "2026-10-29", time_et: "08:30", name: "Personal Income & Outlays (PCE inflation)", type: "pce", source: "bea.gov" },
  { date: "2026-11-03", time_et: "10:00", name: "JOLTS", type: "jolts", source: "bls.gov" },
  { date: "2026-11-06", time_et: "08:30", name: "Employment Situation (Nonfarm Payrolls)", type: "jobs", source: "bls.gov" },
  { date: "2026-11-10", time_et: "08:30", name: "Consumer Price Index (CPI)", type: "cpi", source: "bls.gov" },
  { date: "2026-11-13", time_et: "08:30", name: "Producer Price Index (PPI)", type: "ppi", source: "bls.gov" },
  { date: "2026-11-17", time_et: "08:30", name: "Advance Monthly Retail Sales", type: "retail", source: "census.gov" },
  { date: "2026-11-18", time_et: "14:00", name: "FOMC Minutes", type: "minutes", source: "federalreserve.gov" },
  { date: "2026-11-25", time_et: "08:30", name: "GDP Q3 (Second Estimate)", type: "gdp", source: "bea.gov" },
  { date: "2026-11-25", time_et: "08:30", name: "Personal Income & Outlays (PCE inflation)", type: "pce", source: "bea.gov" },
  { date: "2026-12-01", time_et: "10:00", name: "JOLTS", type: "jolts", source: "bls.gov" },
  { date: "2026-12-04", time_et: "08:30", name: "Employment Situation (Nonfarm Payrolls)", type: "jobs", source: "bls.gov" },
  { date: "2026-12-09", time_et: "14:00", name: "FOMC Rate Decision + Statement + SEP", type: "fomc", source: "federalreserve.gov" },
  { date: "2026-12-10", time_et: "08:30", name: "Consumer Price Index (CPI)", type: "cpi", source: "bls.gov" },
  { date: "2026-12-15", time_et: "08:30", name: "Producer Price Index (PPI)", type: "ppi", source: "bls.gov" },
];
const etToIso = (date: string, hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); const d = new Date(`${date}T12:00:00Z`); const etOffset = /^(2026-1[01]|2026-10)/.test(date) && new Date(`${date}T00:00:00Z`) < new Date("2026-11-01T06:00:00Z") ? 4 : 5; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h + etOffset, m)).toISOString(); };

export const CalendarArgs = z.object({
  days: z.number().int().min(1).max(60).default(7).describe("Look-ahead window in days (default 7)."),
  types: z.array(z.string()).optional().describe("Filter: macro (CPI/PPI/jobs/PCE/GDP/retail/JOLTS), fomc (decisions+minutes), earnings, auctions. Default all."),
  universe: z.array(z.string()).optional().describe("For earnings: restrict to these asset ids."),
});
/** Upcoming scheduled catalysts: US macro prints, FOMC, Treasury auctions and earnings dates from the feed. */
export function calendar(a: z.infer<typeof CalendarArgs>) {
  const now = Date.now(); const until = now + a.days * 86_400_000;
  const want = new Set((a.types ?? ["macro", "fomc", "earnings", "auctions"]).map(t => t.toLowerCase()));
  const out: any[] = [];
  if (want.has("macro") || want.has("fomc")) for (const m of MACRO_2026Q4) {
    const isFomc = m.type === "fomc" || m.type === "minutes"; if ((isFomc && !want.has("fomc")) || (!isFomc && !want.has("macro"))) continue;
    const at = etToIso(m.date, m.time_et); const t = new Date(at).getTime(); if (t < now - 3_600_000 || t > until) continue;
    out.push({ at, type: isFomc ? "fomc" : "macro", subtype: m.type, name: m.name, source: m.source, affects: isFomc || ["cpi", "pce", "jobs"].includes(m.type) ? ["US10Y", "US2Y", "DXY", "SPX", "NDX", "GC", "BTC"] : ["SPX", "US10Y"] });
  }
  if (want.has("earnings") || want.has("auctions")) {
    const evs = queryEvents({ since: new Date(now - 7 * 86_400_000).toISOString(), kinds: [...(want.has("earnings") ? ["corp.earnings"] : []), ...(want.has("auctions") ? ["macro.auction"] : [])], assets: a.universe, limit: 500 });
    for (const e of evs) { const sched = (e.meta as any)?.scheduled_at ?? (e.meta as any)?.date ?? null; const at = sched ? new Date(sched).toISOString() : e.ts_event; const t = new Date(at).getTime(); if (t < now - 3_600_000 || t > until) continue; out.push({ at, type: e.kind === "corp.earnings" ? "earnings" : "auction", name: e.title, assets: e.impacts.slice(0, 5).map(i => i.asset_id), source: e.source.id, url: e.raw_ref }); }
  }
  out.sort((x, y) => x.at.localeCompare(y.at));
  return { from: new Date(now).toISOString(), days: a.days, count: out.length, items: out, note: "Times converted from ET. Schedules compiled from BLS/BEA/Federal Reserve published calendars; verify with the issuer before trading around a print." };
}

export const BriefArgs = z.object({
  asset_id: z.string().describe("Asset id, e.g. NVDA, BTC, MSTR, GC."),
  since: z.string().default("24h").describe('Lookback for events (default 24h).'),
});
/** Premium ($0.10): one-call pre-trade briefing for an asset — pressure, top events, headlines+sentiment, filings, exposure map, related prediction markets, next scheduled catalysts, venue status. */
export async function brief(a: z.infer<typeof BriefArgs>) {
  const id = a.asset_id.toUpperCase(); const asset = loadUniverse().assets.find(x => x.id === id);
  if (!asset) throw new Error(`unknown asset_id ${a.asset_id}`);
  const impact = impactFor({ asset_id: id, since: a.since, limit: 30 } as any);
  const news = newsFor({ ticker: id, since: a.since, limit: 10 });
  const filings = asset.class === "equity" ? filingsFor({ ticker: id, since: "7d", limit: 10 }) : null;
  const graph = neighborhood(id, 1);
  const cal = calendar({ days: 7, universe: [id] } as any);
  let pm: any = null; try { pm = await polymarketContext({ market: asset.name, since: "72h", limit: 5 }); } catch { pm = null; }
  const venues = openVenues(new Date());
  return {
    asset: { id, name: asset.name, class: asset.class, tags: (asset as any).tags ?? [] }, generated_at: new Date().toISOString(), window: a.since,
    pressure: { bias: (impact as any).bias, n_events: (impact as any).n_events, drivers: (impact as any).events?.slice(0, 5) ?? [] },
    headlines: { sentiment_avg: news.sentiment_avg, label: news.sentiment_label, items: news.items.slice(0, 8) },
    filings: filings ? filings.filings.slice(0, 5) : [],
    exposure: { nodes: (graph as any).nodes?.slice(0, 20) ?? [], edges: (graph as any).edges?.slice(0, 30) ?? [] },
    prediction_markets: pm && (pm as any).market?.question ? { question: (pm as any).market.question, yes_prob: (pm as any).market.yes_prob, url: (pm as any).market.url, related_events: (pm as any).n_related } : null,
    upcoming_catalysts: cal.items.slice(0, 8),
    venues_open: venues, tradable_now: Object.entries(venues).filter(([, v]) => v).map(([k]) => k),
    disclaimer: "Information and analytics only — not investment advice.", universe_version: loadUniverse().version,
  };
}
