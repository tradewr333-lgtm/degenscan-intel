import { createHash } from "node:crypto";
import type { Event, EventKind, Impact, RawEvent, Entity } from "../schema.js";
import { Event as EventSchema } from "../schema.js";
import { linkEntities, entitiesFromGeo } from "./entities.js";
import { propagate } from "../graph/graph.js";
import { tradability } from "./sessions.js";

/**
 * Intrinsic sign of an event kind for the entity it is *about*.
 *  -1: bad for the directly named entity;  +1: good;  0: direction depends on content (needs hints/LLM).
 * `horizon` is the default trading horizon.
 */
const KIND_PROFILE: Record<EventKind, { sign: -1 | 0 | 1; horizon: Impact["horizon"]; base: number }> = {
  "nat.quake": { sign: -1, horizon: "intraday", base: 0.6 },
  "nat.storm": { sign: -1, horizon: "days", base: 0.5 },
  "nat.fire": { sign: -1, horizon: "days", base: 0.4 },
  "nat.volcano": { sign: -1, horizon: "days", base: 0.4 },
  "nat.space_weather": { sign: -1, horizon: "intraday", base: 0.2 },
  "nat.flood": { sign: -1, horizon: "days", base: 0.4 },
  "nat.other": { sign: -1, horizon: "days", base: 0.3 },
  "reg.rule": { sign: 0, horizon: "weeks", base: 0.5 },
  "reg.proposed_rule": { sign: 0, horizon: "weeks", base: 0.3 },
  "reg.enforcement": { sign: -1, horizon: "days", base: 0.7 },
  "reg.approval": { sign: 1, horizon: "days", base: 0.7 },
  "reg.sanction": { sign: -1, horizon: "days", base: 0.6 },
  "reg.antitrust": { sign: -1, horizon: "weeks", base: 0.6 },
  "reg.notice": { sign: 0, horizon: "weeks", base: 0.2 },
  "cb.decision": { sign: 0, horizon: "intraday", base: 0.9 },
  "cb.speech": { sign: 0, horizon: "intraday", base: 0.4 },
  "cb.minutes": { sign: 0, horizon: "intraday", base: 0.5 },
  "cb.press": { sign: 0, horizon: "days", base: 0.3 },
  "macro.release": { sign: 0, horizon: "intraday", base: 0.7 },
  "macro.auction": { sign: 0, horizon: "intraday", base: 0.3 },
  "corp.8k": { sign: 0, horizon: "days", base: 0.5 },
  "corp.insider": { sign: 0, horizon: "days", base: 0.3 },
  "corp.activist": { sign: 1, horizon: "days", base: 0.6 },
  "corp.earnings": { sign: 0, horizon: "intraday", base: 0.8 },
  "corp.guidance": { sign: 0, horizon: "intraday", base: 0.8 },
  "corp.mna": { sign: 1, horizon: "days", base: 0.8 },
  "corp.halt": { sign: 0, horizon: "intraday", base: 0.9 },
  "corp.recall": { sign: -1, horizon: "days", base: 0.5 },
  "corp.lawsuit": { sign: -1, horizon: "days", base: 0.4 },
  "corp.press": { sign: 0, horizon: "intraday", base: 0.3 },
  "corp.offering": { sign: -1, horizon: "intraday", base: 0.6 },
  "corp.bankruptcy": { sign: -1, horizon: "intraday", base: 1 },
  "mkt.prediction_shift": { sign: 0, horizon: "days", base: 0.5 },
  "crypto.hack": { sign: -1, horizon: "intraday", base: 0.8 },
  "crypto.listing": { sign: 1, horizon: "intraday", base: 0.5 },
  "crypto.stablecoin_mint": { sign: 1, horizon: "days", base: 0.4 },
  "crypto.liquidation_cascade": { sign: -1, horizon: "intraday", base: 0.7 },
  "crypto.outage": { sign: -1, horizon: "intraday", base: 0.6 },
  "crypto.onchain": { sign: 0, horizon: "intraday", base: 0.3 },
  "geo.conflict": { sign: -1, horizon: "days", base: 0.7 },
  "geo.protest": { sign: -1, horizon: "days", base: 0.3 },
  "geo.election": { sign: 0, horizon: "weeks", base: 0.5 },
  "geo.outage": { sign: -1, horizon: "intraday", base: 0.4 },
  "geo.other": { sign: 0, horizon: "days", base: 0.2 },
  "media.spike": { sign: 0, horizon: "intraday", base: 0.3 },
  "media.report": { sign: 0, horizon: "intraday", base: 0.2 },
};

/** Crude directional cues in text for sign-0 kinds. Deterministic, cheap. */
const POS = /\b(approv(?:es|ed|al)|beats?|raises? guidance|record (?:revenue|profit)|upgrade|buyback|dividend increase|acquire[sd]?|acquisition of|to acquire|cleared|wins?|granted|rate cut|cuts? rates?|dovish|settle[sd]?)\b/i;
const NEG = /\b(misses?|cuts? guidance|lowers? (?:guidance|outlook)|downgrade|recall|probe|investigat|charges?|fine[sd]?|penalt|lawsuit|sues?|bankrupt|chapter 11|default|halt|resign|steps down|terminat|breach|hack|exploit|outage|sanction|ban[s]?|block(?:s|ed)|rate hike|hikes? rates?|hawkish|delist|layoffs?|warning|explosion|strike|attack)\b/i;

export function inferSign(kind: EventKind, text: string): -1 | 0 | 1 {
  const p = KIND_PROFILE[kind].sign;
  if (p !== 0) return p;
  const pos = POS.test(text), neg = NEG.test(text);
  if (pos && !neg) return 1;
  if (neg && !pos) return -1;
  return 0;
}

export function eventId(sourceId: string, nativeId: string) {
  return createHash("sha1").update(`${sourceId}|${nativeId}`).digest("hex").slice(0, 20);
}

/** Enrich a RawEvent from a connector into a full scored Event. Pure & deterministic. */
export function scoreEvent(raw: RawEvent, now = new Date()): Event {
  const text = [raw.title, raw.summary, ...(raw.text_hints ?? [])].join(" \n ");
  let entities: Entity[] = linkEntities(text, raw.entities ?? []);
  if (raw.geo) {
    const radius = raw.geo.radius_km ?? 150;
    for (const e of entitiesFromGeo(raw.geo.lat, raw.geo.lng, radius, raw.geo.country)) if (!entities.find(x => x.id === e.id)) entities.push(e);
  }

  const profile = KIND_PROFILE[raw.kind];
  const sign = inferSign(raw.kind, text);
  // A regulator or country named alongside a specific company is context, not the subject: damp those seeds so
  // "SEC charges <random company>" doesn't hit every SEC-regulated name at full weight.
  const hasSpecific = entities.some(e => e.type === "company" || e.type === "asset" || e.type === "facility" || e.type === "protocol");
  const seedWeight = (e: Entity) => {
    if (e.type === "regulator") {
      // Enforcement/corporate items that name no universe entity are about someone else: near-zero spillover.
      const generic = !hasSpecific && (raw.kind === "reg.enforcement" || raw.kind === "reg.notice" || raw.kind.startsWith("corp."));
      return e.confidence * (hasSpecific ? 0.3 : generic ? 0.2 : 0.6);
    }
    if (e.type === "country" && !raw.geo) return e.confidence * (hasSpecific ? 0.4 : 0.7);
    if (e.type === "sector") return e.confidence * 0.5; // themes
    return e.confidence;
  };
  const seeds = entities.map(e => ({ node: e.id, weight: seedWeight(e), sign: (sign === 0 ? 1 : sign) as 1 | -1 }));
  const props = propagate(seeds, 3, 0.05);

  const magnitude = Math.min(1, profile.base * (0.5 + raw.severity) * (0.5 + raw.novelty));
  const impacts: Impact[] = props.map(p => {
    const confidence = Math.min(1, magnitude * p.weight * (raw.source.tier === "primary" ? 1 : raw.source.tier === "aggregator" ? 0.8 : 0.6));
    const direction = sign === 0 ? 0 : p.sign;
    return {
      asset_id: p.asset_id,
      direction: direction as -1 | 0 | 1,
      confidence: Math.round(confidence * 1000) / 1000,
      horizon: profile.horizon,
      path: p.path,
      rationale: rationale(raw.kind, p.path, direction),
    };
  }).filter(i => i.confidence >= 0.05).sort((a, b) => b.confidence - a.confidence).slice(0, 25);

  const ts_observed = now.toISOString();
  const latency = Math.max(0, now.getTime() - new Date(raw.ts_event).getTime());
  const { tradable_now, next_open } = tradability(impacts.map(i => i.asset_id), now);

  const ev: Event = {
    id: eventId(raw.source.id, raw.native_id),
    ts_event: raw.ts_event,
    ts_observed,
    latency_ms: latency,
    source: raw.source,
    kind: raw.kind,
    title: raw.title.slice(0, 300),
    summary: raw.summary.slice(0, 600),
    entities,
    geo: raw.geo,
    severity: raw.severity,
    novelty: raw.novelty,
    impacts,
    corroboration: { count: 1, sources: [raw.source.id] },
    tradable_now,
    next_open,
    raw_ref: raw.raw_ref,
    meta: raw.meta,
  };
  return EventSchema.parse(ev);
}

function rationale(kind: EventKind, path: string[], direction: number): string {
  const via = path.length > 2 ? ` via ${path.slice(1, -1).map(n => n.split(":")[1]).join(" → ")}` : "";
  const dir = direction > 0 ? "supportive" : direction < 0 ? "negative" : "direction unclear";
  return `${kind} on ${path[0].split(":")[1]}${via}: ${dir} for ${path[path.length - 1].split(":")[1]}`;
}
