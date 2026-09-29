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
  let derivs: any = null; if (asset.class === "crypto") { try { const d = await derivsFor({ symbol: id, since: a.since }); derivs = { funding_1h: d.funding.rate_1h, funding_annualized_pct: d.funding.annualized_pct, open_interest_usd: d.open_interest.usd, premium_vs_oracle: d.price.premium_vs_oracle, volume_24h_usd: d.volume_24h_usd, flags: d.flags }; } catch { derivs = null; } }
  const venues = openVenues(new Date());
  return {
    asset: { id, name: asset.name, class: asset.class, tags: (asset as any).tags ?? [] }, generated_at: new Date().toISOString(), window: a.since,
    pressure: { bias: (impact as any).bias, n_events: (impact as any).n_events, drivers: (impact as any).events?.slice(0, 5) ?? [] },
    headlines: { sentiment_avg: news.sentiment_avg, label: news.sentiment_label, items: news.items.slice(0, 8) },
    filings: filings ? filings.filings.slice(0, 5) : [],
    exposure: { nodes: (graph as any).nodes?.slice(0, 20) ?? [], edges: (graph as any).edges?.slice(0, 30) ?? [] },
    prediction_markets: pm && (pm as any).market?.question ? { question: (pm as any).market.question, yes_prob: (pm as any).market.yes_prob, url: (pm as any).market.url, related_events: (pm as any).n_related } : null,
    upcoming_catalysts: cal.items.slice(0, 8),
    derivatives: derivs,
    venues_open: venues, tradable_now: Object.entries(venues).filter(([, v]) => v).map(([k]) => k),
    disclaimer: "Information and analytics only — not investment advice.", universe_version: loadUniverse().version,
  };
}

// ---------------------------------------------------------------------------
// derivs_for — perpetual-futures microstructure from Hyperliquid's public info API
// (funding, open interest, premium vs oracle, 24h notional volume, cross-venue predicted funding),
// joined with our event pressure on the same asset. No key required; Hyperliquid data is public.
// ---------------------------------------------------------------------------
export const DerivsArgs = z.object({
  symbol: z.string().describe("Perp coin as listed on Hyperliquid, e.g. BTC, ETH, SOL, HYPE, DOGE. Case-insensitive."),
  since: z.string().default("24h").describe("Lookback for our event pressure on the same asset (default 24h)."),
});
export type DerivsArgs = z.infer<typeof DerivsArgs>;

const HL_INFO = process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";
type HlCtx = { funding: string; openInterest: string; prevDayPx: string; dayNtlVlm: string; premium: string | null; oraclePx: string; markPx: string; midPx: string | null; impactPxs?: string[] | null; dayBaseVlm?: string };
type HlMeta = { universe: { name: string; szDecimals: number; maxLeverage: number; isDelisted?: boolean }[] };
let hlCache: { at: number; meta: HlMeta; ctxs: HlCtx[] } | null = null;
let hlPredCache: { at: number; rows: [string, [string, { fundingRate: string; nextFundingTime: number; fundingIntervalHours?: number }][]][] } | null = null;

async function hlPost<T>(body: unknown, timeoutMs = 8000): Promise<T> {
  const res = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} hyperliquid info`);
  return res.json() as Promise<T>;
}
/** Exposed for tests: inject a fake fetcher. */
export const _hl = { post: hlPost as <T>(body: unknown) => Promise<T>, reset() { hlCache = null; hlPredCache = null; hlVolCache = new Map(); } };

async function hlMetaAndCtxs() {
  if (hlCache && Date.now() - hlCache.at < 30_000) return hlCache;
  const [meta, ctxs] = await _hl.post<[HlMeta, HlCtx[]]>({ type: "metaAndAssetCtxs" });
  hlCache = { at: Date.now(), meta, ctxs }; return hlCache;
}
async function hlPredicted() {
  if (hlPredCache && Date.now() - hlPredCache.at < 60_000) return hlPredCache.rows;
  try { const rows = await _hl.post<typeof hlPredCache extends infer T ? T extends { rows: infer R } ? R : never : never>({ type: "predictedFundings" }); hlPredCache = { at: Date.now(), rows: rows as any }; return hlPredCache.rows; }
  catch { return hlPredCache?.rows ?? []; }
}
type HlCandle = { t: number; T: number; c: string };
let hlVolCache = new Map<string, { at: number; v: { realized_vol_30d_ann: number; n: number } | null }>();
/** 30-day realized volatility, annualised: sample stdev of daily log-returns of Hyperliquid 1d closes × √365.
 *  Public candleSnapshot endpoint, cached 1 h. Drops the still-open candle. Returns null when < 20 closes are available. */
export async function realizedVol30d(symbol: string): Promise<{ realized_vol_30d_ann: number; n: number } | null> {
  const sym = symbol.toUpperCase();
  const hit = hlVolCache.get(sym);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.v;
  const now = Date.now();
  let v: { realized_vol_30d_ann: number; n: number } | null = null;
  try {
    const rows = await _hl.post<HlCandle[]>({ type: "candleSnapshot", req: { coin: sym, interval: "1d", startTime: now - 36 * 86_400_000, endTime: now } });
    const closes = (rows ?? []).filter(c => c.T <= now).map(c => Number(c.c)).filter(Number.isFinite).slice(-31);
    if (closes.length >= 20) {
      const lr = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
      const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
      const sd = Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / (lr.length - 1));
      v = { realized_vol_30d_ann: r(sd * Math.sqrt(365), 4)!, n: lr.length };
    }
  } catch { v = hit?.v ?? null; }
  hlVolCache.set(sym, { at: Date.now(), v }); return v;
}
const num = (v: string | number | null | undefined) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r = (n: number | null, d = 6) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d;

/** Perp microstructure for one coin (Hyperliquid public API, ~30 s cache) + our event pressure on the same asset. */
export async function derivsFor(a: DerivsArgs) {
  const sym = a.symbol.toUpperCase().replace(/-PERP$|USDT?$|USDC$/i, "");
  const { meta, ctxs } = await hlMetaAndCtxs();
  const idx = meta.universe.findIndex(u => u.name.toUpperCase() === sym);
  if (idx < 0) throw new Error(`unknown perp symbol ${a.symbol} on Hyperliquid (${meta.universe.length} listed; e.g. BTC, ETH, SOL, HYPE)`);
  const u = meta.universe[idx], c = ctxs[idx];
  const mark = num(c.markPx), oracle = num(c.oraclePx), mid = num(c.midPx), prev = num(c.prevDayPx), oi = num(c.openInterest), vol = num(c.dayNtlVlm), f1h = num(c.funding), prem = num(c.premium);
  const pred = (await hlPredicted()).find(row => String(row[0]).toUpperCase() === sym)?.[1] ?? [];
  const predicted_funding = pred.filter(([, p]) => p && typeof p === "object").map(([venue, p]) => ({ venue, rate: r(num(p.fundingRate), 8), interval_h: p.fundingIntervalHours ?? (venue === "HlPerp" ? 1 : 8), next_at: p.nextFundingTime ? new Date(p.nextFundingTime).toISOString() : null }));
  const fundingAnnual = f1h == null ? null : f1h * 24 * 365;
  const flags: string[] = [];
  if (f1h != null && Math.abs(f1h) >= 0.0005) flags.push(f1h > 0 ? "funding_hot_long" : "funding_hot_short"); // ≥ 0.05%/h ≈ 438%/yr
  if (prem != null && Math.abs(prem) >= 0.002) flags.push(prem > 0 ? "premium_rich" : "premium_discount");
  if (oi != null && mark != null && vol != null && vol > 0 && (oi * mark) / vol > 3) flags.push("oi_heavy_vs_volume");
  let pressure: any = null;
  if (loadUniverse().assets.some(x => x.id === sym)) { try { const imp: any = impactFor({ asset_id: sym, since: a.since, limit: 10 } as any); pressure = { bias: imp.bias, n_events: imp.n_events, drivers: (imp.top ?? []).slice(0, 5).map((e: any) => ({ id: e.event_id, title: e.title, kind: e.kind, direction: e.impact?.direction ?? 0, confidence: e.impact?.confidence ?? 0 })) }; } catch { pressure = null; } }
  return {
    symbol: sym, venue: "hyperliquid", as_of: new Date().toISOString(), max_leverage: u.maxLeverage,
    price: { mark, oracle, mid, prev_day: prev, change_24h_pct: mark != null && prev ? r(((mark - prev) / prev) * 100, 3) : null, premium_vs_oracle: r(prem, 6) },
    funding: { rate_1h: r(f1h, 8), rate_8h_equiv: r(f1h == null ? null : f1h * 8, 8), annualized_pct: r(fundingAnnual == null ? null : fundingAnnual * 100, 2), predicted_by_venue: predicted_funding },
    open_interest: { coins: r(oi, 4), usd: oi != null && mark != null ? Math.round(oi * mark) : null, oi_to_24h_volume: oi != null && mark != null && vol ? r((oi * mark) / vol, 3) : null },
    volume_24h_usd: vol != null ? Math.round(vol) : null,
    flags, event_pressure: pressure,
    not_included: ["liquidations (no keyless public source with clear terms yet)", "long/short account ratio"],
    source: { id: "hyperliquid.info", url: "https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint", tier: "primary" },
    disclaimer: "Information and analytics only — not investment advice.", universe_version: loadUniverse().version,
  };
}

// ---------------------------------------------------------------------------
// v0.8 — "entry shelf": the cheap, high-frequency, no-key data agents already buy
// (price, funding alerts, whale moves, Polymarket top). All from public sources, 30–60 s cache,
// ~1 KB responses, each pointing back to our event feed via `related`.
// ---------------------------------------------------------------------------
type Fetcher = <T>(url: string, init?: RequestInit & { timeoutMs?: number }) => Promise<T>;
const defaultGet: Fetcher = async (url, init = {}) => {
  const { timeoutMs = 8000, ...rest } = init;
  const res = await fetch(url, { ...rest, headers: { accept: "application/json", "user-agent": "degenscan-intel/0.8 (+https://intel.degenscan.io)", ...(rest.headers as any ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json() as Promise<any>;
};
/** Exposed for tests: inject a fake fetcher and clear caches. */
export const _ext = { get: defaultGet, reset() { cache.clear(); hlCache = null; hlPredCache = null; hlVolCache = new Map(); } };
const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const c = cache.get(key); if (c && Date.now() - c.at < ttlMs) return c.v as T;
  const v = await fn(); cache.set(key, { at: Date.now(), v }); return v;
}
const relatedFor = (asset: string) => ({ events: `/v1/events?since=4h&universe=${asset}`, impact: `/v1/impact/${asset}?since=24h`, derivs: `/v1/derivs/${asset}` });

// --- price_for ---------------------------------------------------------------
export const PriceArgs = z.object({ symbol: z.string().describe("Coin, e.g. BTC, ETH, SOL, HYPE (Hyperliquid perp mark + Coinbase spot when available)") });
/** $0.001 — mark/mid/oracle from Hyperliquid, spot from Coinbase (public, no key), 24h change, 30d realized vol (annualised), plus links to our event pressure. */
export async function priceFor(a: z.infer<typeof PriceArgs>) {
  const sym = a.symbol.toUpperCase().replace(/-PERP$|USDT?$|USDC$|-USD$/i, "");
  const { meta, ctxs } = await hlMetaAndCtxs();
  const idx = meta.universe.findIndex(u => u.name.toUpperCase() === sym);
  const c = idx >= 0 ? ctxs[idx] : null;
  const mark = c ? num(c.markPx) : null, prev = c ? num(c.prevDayPx) : null;
  let spot: number | null = null;
  try { const cb = await cached(`cb:${sym}`, 30_000, () => _ext.get<any>(`https://api.coinbase.com/v2/prices/${sym}-USD/spot`, { timeoutMs: 5000 })); spot = num(cb?.data?.amount); } catch { spot = null; }
  if (mark == null && spot == null) throw new Error(`unknown symbol ${a.symbol} (not on Hyperliquid perps nor Coinbase spot)`);
  const vol = c ? await realizedVol30d(sym) : null;
  return {
    symbol: sym, as_of: new Date().toISOString(),
    realized_vol_30d_ann: vol?.realized_vol_30d_ann ?? null, realized_vol_note: vol ? `stdev of ${vol.n} daily log-returns (Hyperliquid 1d closes) × √365` : "unavailable",
    perp: c ? { venue: "hyperliquid", mark, mid: num(c.midPx), oracle: num(c.oraclePx), prev_day: prev, change_24h_pct: mark != null && prev ? r(((mark - prev) / prev) * 100, 3) : null, funding_1h: r(num(c.funding), 8), volume_24h_usd: c.dayNtlVlm ? Math.round(Number(c.dayNtlVlm)) : null } : null,
    spot: spot != null ? { venue: "coinbase", price: spot } : null,
    basis_pct: mark != null && spot ? r(((mark - spot) / spot) * 100, 4) : null,
    related: relatedFor(sym), source: { hyperliquid: "https://api.hyperliquid.xyz/info", coinbase: "https://api.coinbase.com/v2/prices" },
    disclaimer: "Information only — not investment advice.",
  };
}

// --- funding_alerts ----------------------------------------------------------
export const FundingAlertsArgs = z.object({
  min_abs_rate_1h: z.number().min(0).default(0.0003).describe("Alert threshold on |hourly funding|. Default 0.0003 (=0.03%/h ≈ 263%/yr)."),
  limit: z.number().int().min(1).max(50).default(15),
});
/** $0.001 — coins with extreme funding right now on Hyperliquid (+ predicted funding per venue), sorted by |rate|. Poll every 5–15 min. */
export async function fundingAlerts(a: z.infer<typeof FundingAlertsArgs>) {
  const { meta, ctxs } = await hlMetaAndCtxs();
  const pred = await hlPredicted();
  const predMap = new Map<string, any[]>(pred.map(row => [String(row[0]).toUpperCase(), (row[1] ?? []).filter(([, p]: any) => p && typeof p === "object")] as any));
  const rows = meta.universe.map((u, i) => ({ u, c: ctxs[i] })).filter(x => x.c && !x.u.isDelisted).map(({ u, c }) => {
    const f = num(c.funding) ?? 0, oi = num(c.openInterest), mark = num(c.markPx);
    return { symbol: u.name, funding_1h: r(f, 8), annualized_pct: r(f * 24 * 365 * 100, 1), side_paying: f > 0 ? "longs" : f < 0 ? "shorts" : "flat", open_interest_usd: oi != null && mark != null ? Math.round(oi * mark) : null, mark,
      predicted_by_venue: (predMap.get(u.name.toUpperCase()) ?? []).map(([venue, p]: any) => ({ venue, rate: r(num(p.fundingRate), 8) })), abs: Math.abs(f) };
  }).filter(x => x.abs >= a.min_abs_rate_1h).sort((x, y) => y.abs - x.abs).slice(0, a.limit).map(({ abs, ...x }) => ({ ...x, related: relatedFor(x.symbol) }));
  return { as_of: new Date().toISOString(), venue: "hyperliquid", threshold_abs_rate_1h: a.min_abs_rate_1h, count: rows.length, alerts: rows, note: "Positive funding = longs pay shorts (crowded long). Compare predicted_by_venue for cross-venue divergence.", disclaimer: "Information only — not investment advice." };
}

// --- whale_moves -------------------------------------------------------------
const WHALE_TOKENS: { chain: string; api: string; token: string; symbol: string; decimals: number }[] = [
  { chain: "base", api: "https://base.blockscout.com", token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", decimals: 6 },
  { chain: "ethereum", api: "https://eth.blockscout.com", token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 },
  { chain: "ethereum", api: "https://eth.blockscout.com", token: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6 },
];
// Public, widely documented exchange deposit/hot wallets (labels are best-effort; unknown → "unlabeled").
const KNOWN_LABELS: Record<string, string> = {
  "0x28c6c06298d514db089934071355e5743bf21d60": "Binance 14", "0x21a31ee1afc51d94c2efccaa2092ad1028285549": "Binance 15", "0xdfd5293d8e347dfe59e90efd55b2956a1343963d": "Binance 16",
  "0x56eddb7aa87536c09ccc2793473599fd21a8b17f": "Binance 17", "0x9696f59e4d72e237be84ffd425dcad154bf96976": "Binance 18", "0x4976a4a02f38326660d17bf34b431dc6e2eb2327": "Binance 20",
  "0x71660c4005ba85c37ccec55d0c4493e05b8c8f87": "Coinbase 1", "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase 2", "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "Coinbase 3",
  "0x3cd751e6b0078be393132286c442345e5dc49699": "Coinbase 4", "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "Coinbase 5", "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43": "Coinbase 10",
  "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance 8", "0x5041ed759dd4afc3a72b8192c143f72f4724081a": "OKX", "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX 2",
  "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit", "0x1b46970cfe6a271e884f6a5a2e5e2e4e0a0c7c33": "Bybit 2", "0x2faf487a4414fe77e2327f0bf4ae2a264a776ad2": "FTX (legacy)",
  "0x0d0707963952f2fba59dd06f2b425ace40b492fe": "Gate.io", "0x1151314c646ce4e0efd76d1af4760ae66a9fe30f": "Bitfinex", "0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec": "Bitfinex 2",
  "0xe93381fb4c4f14bda253907b18fad305d799241a": "Huobi", "0x46340b20830761efd32832a74d7169b29feb9758": "Crypto.com", "0x6262998ced04146fa42253a5c0af90ca02dfd2a3": "Crypto.com 2",
  "0x0000000000000000000000000000000000000000": "mint/burn",
};
export const WhaleArgs = z.object({
  min_usd: z.number().min(10_000).default(1_000_000).describe("Minimum transfer size in USD. Default 1,000,000."),
  chains: z.array(z.enum(["base", "ethereum"])).optional().describe("Default both."),
  limit: z.number().int().min(1).max(100).default(25),
});
/** $0.002 — large stablecoin transfers (USDC/USDT) on Base and Ethereum from public Blockscout APIs (no key), with best-effort exchange labels and a flow tag (to_exchange / from_exchange / wallet_to_wallet / mint / burn). 60 s cache. */
export async function whaleMoves(a: z.infer<typeof WhaleArgs>) {
  const chains = a.chains ?? ["base", "ethereum"];
  const targets = WHALE_TOKENS.filter(t => chains.includes(t.chain as any));
  const results = await Promise.all(targets.map(t => cached(`whale:${t.chain}:${t.symbol}`, 60_000, async () => {
    try { const j = await _ext.get<any>(`${t.api}/api/v2/tokens/${t.token}/transfers`, { timeoutMs: 8000 }); return { t, items: (j?.items ?? []) as any[] }; }
    catch (e) { return { t, items: [] as any[], error: String((e as Error).message) }; }
  })));
  const label = (addr: string) => KNOWN_LABELS[addr.toLowerCase()] ?? null;
  const moves = results.flatMap(({ t, items }) => items.map((x: any) => {
    const raw = x.total?.value ?? x.value ?? "0"; const usd = Number(raw) / 10 ** t.decimals;
    const from = String(x.from?.hash ?? ""), to = String(x.to?.hash ?? "");
    const fl = label(from) ?? (x.from?.name || null), tl = label(to) ?? (x.to?.name || null);
    const flow = from === "0x0000000000000000000000000000000000000000" ? "mint" : to === "0x0000000000000000000000000000000000000000" ? "burn" : tl && !fl ? "to_exchange" : fl && !tl ? "from_exchange" : fl && tl ? "exchange_to_exchange" : "wallet_to_wallet";
    return { chain: t.chain, token: t.symbol, usd: Math.round(usd), from, from_label: fl ?? "unlabeled", to, to_label: tl ?? "unlabeled", flow, tx: x.transaction_hash ?? x.tx_hash ?? null, at: x.timestamp ?? null, explorer: x.transaction_hash ? `${t.api}/tx/${x.transaction_hash}` : null };
  })).filter(m => m.usd >= a.min_usd).sort((x, y) => y.usd - x.usd).slice(0, a.limit);
  const errors = results.filter(r => (r as any).error).map(r => ({ chain: r.t.chain, token: r.t.symbol, error: (r as any).error }));
  const sum = (f: string) => moves.filter(m => m.flow === f).reduce((s, m) => s + m.usd, 0);
  return { as_of: new Date().toISOString(), min_usd: a.min_usd, chains, count: moves.length, totals_usd: { to_exchange: sum("to_exchange"), from_exchange: sum("from_exchange"), mint: sum("mint"), burn: sum("burn"), wallet_to_wallet: sum("wallet_to_wallet") }, moves, sources_unavailable: errors,
    related: { events: "/v1/events?since=4h&universe=BTC,ETH", pulse: "/v1/pulse" }, note: "Recent transfers window as served by Blockscout (latest page). Labels are best-effort public exchange wallets; 'unlabeled' is not 'retail'.", disclaimer: "Information only — not investment advice." };
}

// --- polymarket_top ----------------------------------------------------------
export const PolyTopArgs = z.object({
  sort: z.enum(["volume_24h", "liquidity", "change_24h"]).default("volume_24h"),
  limit: z.number().int().min(1).max(50).default(20),
  tag: z.string().optional().describe("Optional Gamma tag slug filter, e.g. 'crypto', 'fed', 'politics'."),
});
/** $0.002 — the most active Polymarket markets right now: yes odds, 24h change, 24h volume, liquidity, end date, plus a link to our evidence pack per market. 60 s cache. */
export async function polymarketTop(a: z.infer<typeof PolyTopArgs>) {
  const order = a.sort === "liquidity" ? "liquidity" : a.sort === "change_24h" ? "oneDayPriceChange" : "volume24hr";
  const url = `https://gamma-api.polymarket.com/markets?active=true&closed=false&order=${order}&ascending=false&limit=${a.limit}${a.tag ? `&tag_slug=${encodeURIComponent(a.tag)}` : ""}`;
  const raw = await cached(`pmtop:${url}`, 60_000, () => _ext.get<any[]>(url, { timeoutMs: 8000 }));
  const markets = (Array.isArray(raw) ? raw : []).map((m: any) => {
    let yes: number | null = null; try { const p = typeof m.outcomePrices === "string" ? JSON.parse(m.outcomePrices) : m.outcomePrices; yes = p ? num(p[0]) : null; } catch { yes = null; }
    return { id: String(m.id), slug: m.slug, question: m.question, yes_prob: yes != null ? r(yes, 4) : null, change_24h: r(num(m.oneDayPriceChange), 4), volume_24h_usd: m.volume24hr != null ? Math.round(Number(m.volume24hr)) : null, liquidity_usd: m.liquidity != null ? Math.round(Number(m.liquidity)) : null, end_date: m.endDate ?? null, url: m.slug ? `https://polymarket.com/market/${m.slug}` : null, evidence: `/v1/polymarket/${encodeURIComponent(m.slug ?? m.id)}?since=48h` };
  });
  return { as_of: new Date().toISOString(), sort: a.sort, tag: a.tag ?? null, count: markets.length, markets, source: { id: "polymarket.gamma", url: "https://gamma-api.polymarket.com" }, note: "yes_prob = current YES price. Use `evidence` for the primary-source events that bear on each question.", disclaimer: "Information only — not investment advice." };
}
