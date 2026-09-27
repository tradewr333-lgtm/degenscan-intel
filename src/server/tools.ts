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
  min_severity: z.number().min(0).max(1).optional(),
  min_confidence: z.number().min(0).max(1).optional().describe("Min impact confidence (only with universe)."),
  q: z.string().optional().describe("Full-text query over title/summary (FTS5 syntax)."),
  limit: z.number().int().min(1).max(200).default(50),
});
export type EventsSinceArgs = z.infer<typeof EventsSinceArgs>;

export function eventsSince(a: EventsSinceArgs) {
  const since = parseSince(a.since);
  const events = queryEvents({ since, until: a.until ? parseSince(a.until) : undefined, kinds: a.kinds, assets: a.universe, min_severity: a.min_severity, min_confidence: a.min_confidence, q: a.q, limit: a.limit });
  return { since, until: a.until ?? new Date().toISOString(), count: events.length, universe_version: loadUniverse().version, events };
}

export const ImpactForArgs = z.object({
  asset_id: z.string().describe("Universe asset id, e.g. NVDA, BTC, CL, US10Y, SPX"),
  since: z.string().default("24h"),
  limit: z.number().int().min(1).max(200).default(50),
});
export function impactFor(a: z.infer<typeof ImpactForArgs>) {
  const asset = loadUniverse().assets.find(x => x.id === a.asset_id.toUpperCase());
  if (!asset) throw new Error(`unknown asset_id ${a.asset_id}; call universe`);
  return { asset, ...impactsForAsset(asset.id, parseSince(a.since), a.limit) };
}

export const ExposureGraphArgs = z.object({ asset_id: z.string(), depth: z.number().int().min(1).max(3).default(2) });
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
