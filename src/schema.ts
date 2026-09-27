import { z } from "zod";

/** Event kinds — hierarchical dotted taxonomy. Keep in sync with docs/SPEC.md §4. */
export const EVENT_KINDS = [
  "nat.quake", "nat.storm", "nat.fire", "nat.volcano", "nat.space_weather", "nat.flood", "nat.other",
  "reg.rule", "reg.proposed_rule", "reg.enforcement", "reg.approval", "reg.sanction", "reg.antitrust", "reg.notice",
  "cb.decision", "cb.speech", "cb.minutes", "cb.press",
  "macro.release", "macro.auction",
  "corp.8k", "corp.insider", "corp.activist", "corp.earnings", "corp.guidance", "corp.mna",
  "corp.halt", "corp.recall", "corp.lawsuit", "corp.press", "corp.offering", "corp.bankruptcy",
  "mkt.prediction_shift",
  "crypto.hack", "crypto.listing", "crypto.stablecoin_mint", "crypto.liquidation_cascade", "crypto.outage", "crypto.onchain",
  "geo.conflict", "geo.protest", "geo.election", "geo.outage", "geo.other",
  "media.spike", "media.report",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EntityType = z.enum([
  "company", "asset", "country", "commodity", "regulator", "person", "facility", "protocol", "sector", "index",
]);
export type EntityType = z.infer<typeof EntityType>;

export const Entity = z.object({
  type: EntityType,
  id: z.string(),          // e.g. company:NVDA, country:TW, commodity:CL
  name: z.string(),
  confidence: z.number().min(0).max(1).default(1),
});
export type Entity = z.infer<typeof Entity>;

export const Impact = z.object({
  asset_id: z.string(),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  confidence: z.number().min(0).max(1),
  horizon: z.enum(["intraday", "days", "weeks"]),
  path: z.array(z.string()),
  rationale: z.string(),
});
export type Impact = z.infer<typeof Impact>;

export const Source = z.object({
  id: z.string(),
  name: z.string(),
  tier: z.enum(["primary", "aggregator", "media"]),
  url: z.string().url().optional(),
});
export type Source = z.infer<typeof Source>;

export const Event = z.object({
  id: z.string(),
  ts_event: z.string(),
  ts_observed: z.string(),
  latency_ms: z.number().int(),
  source: Source,
  kind: z.enum(EVENT_KINDS),
  title: z.string(),
  summary: z.string().max(600),
  entities: z.array(Entity),
  geo: z.object({
    lat: z.number(), lng: z.number(),
    country: z.string().optional(), radius_km: z.number().optional(),
  }).optional(),
  severity: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  impacts: z.array(Impact),
  corroboration: z.object({ count: z.number().int(), sources: z.array(z.string()) }),
  tradable_now: z.array(z.string()),
  next_open: z.array(z.object({ asset_id: z.string(), at: z.string() })),
  raw_ref: z.string(),
  meta: z.record(z.unknown()).optional(),
});
export type Event = z.infer<typeof Event>;

/** What a connector produces before entity-linking and impact scoring. */
export type RawEvent = Omit<
  Event,
  "id" | "ts_observed" | "latency_ms" | "impacts" | "corroboration" | "tradable_now" | "next_open" | "entities"
> & {
  native_id: string;
  entities?: Entity[];
  /** free-text hints the entity linker will scan (title+summary are always scanned) */
  text_hints?: string[];
};

export const AssetClass = z.enum(["equity", "etf", "index", "crypto", "commodity", "fx", "rate"]);
export type AssetClass = z.infer<typeof AssetClass>;

export const Session = z.object({
  tz: z.string(),        // IANA
  open: z.string(),      // "09:30"
  close: z.string(),     // "16:00"
  days: z.array(z.number().int().min(0).max(6)), // 0=Sun
  always: z.boolean().optional(),                // crypto 24/7
});
export type Session = z.infer<typeof Session>;

export const Asset = z.object({
  id: z.string(),                 // "NVDA", "BTC", "CL", "US10Y"
  name: z.string(),
  class: AssetClass,
  venue: z.string(),
  sessions: z.array(Session),
  cik: z.string().optional(),
  coingecko_id: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type Asset = z.infer<typeof Asset>;

export const Universe = z.object({
  version: z.string(),
  generated_at: z.string(),
  assets: z.array(Asset),
});
export type Universe = z.infer<typeof Universe>;
