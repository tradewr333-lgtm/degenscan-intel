import type { RawEvent, EventKind, Entity, Source } from "../schema.js";
import { fetchRss, stripHtml, type RssItem } from "./http.js";

export interface Connector {
  id: string;
  name: string;
  tier: Source["tier"];
  /** polling cadence in seconds */
  cadence_s: number;
  /** homepage / docs of the source */
  url: string;
  /** whether an API key is required (env var name) */
  key_env?: string;
  run(): Promise<RawEvent[]>;
}

export interface RssMap {
  kind: (it: RssItem) => EventKind | null;          // return null to skip item
  severity?: (it: RssItem) => number;
  novelty?: (it: RssItem) => number;
  entities?: (it: RssItem) => Entity[];
  hints?: (it: RssItem) => string[];
  summary?: (it: RssItem) => string;
}

export function src(c: Pick<Connector, "id" | "name" | "tier" | "url">): Source {
  return { id: c.id, name: c.name, tier: c.tier, url: c.url };
}

/** Generic RSS/Atom connector. */
export function rssConnector(
  def: Omit<Connector, "run"> & { feed: string | string[]; /** treat feeds as ordered fallbacks: stop at first that works */ fallback_chain?: boolean },
  map: RssMap,
): Connector {
  const feeds = Array.isArray(def.feed) ? def.feed : [def.feed];
  return {
    ...def,
    async run() {
      const out: RawEvent[] = [];
      const source = src(def);
      const errors: string[] = [];
      let okFeeds = 0;
      for (const feed of feeds) {
        let items: RssItem[];
        try { items = await fetchRss(feed); okFeeds++; } catch (e) { errors.push(`${feed}: ${(e as Error).message}`); continue; }
        // Once a primary feed works we skip the remaining (fallback) feeds
        for (const it of items) {
          const kind = map.kind(it);
          if (!kind || !it.title) continue;
          const summary = map.summary ? map.summary(it) : stripHtml(it.contentSnippet ?? it.content).slice(0, 600);
          out.push({
            native_id: it.guid,
            ts_event: it.isoDate ?? new Date().toISOString(),
            source,
            kind,
            title: it.title,
            summary,
            entities: map.entities?.(it),
            text_hints: map.hints?.(it),
            severity: clamp(map.severity?.(it) ?? 0.4),
            novelty: clamp(map.novelty?.(it) ?? 0.5),
            raw_ref: it.link ?? feed,
          });
        }
        if (okFeeds && def.fallback_chain) break;
      }
      if (!okFeeds) throw new Error(errors.join(" | "));
      return out;
    },
  };
}

export const clamp = (x: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, Number.isFinite(x) ? x : lo));
export const has = (s: string | undefined, ...words: string[]) => !!s && words.some(w => s.toLowerCase().includes(w.toLowerCase()));
export const ent = (type: Entity["type"], id: string, name = id, confidence = 1): Entity => ({ type, id, name, confidence });
