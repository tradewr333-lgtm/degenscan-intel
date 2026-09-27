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
  const minHits = Math.max(1, Math.ceil(terms.length * 0.4));   // e.g. 3 terms → 2 hits; avoids one generic word pulling in noise
  const scored = events.map(e => { const hay = `${e.title} ${e.summary}`.toLowerCase(); const hits = terms.filter(t => hay.includes(t)).length; return { e, hits }; })
    .filter(x => x.hits >= minHits).sort((x, y) => y.hits - x.hits || y.e.severity - x.e.severity).slice(0, a.limit);
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
