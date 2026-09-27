import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Universe, type Asset } from "../schema.js";
import { SEED_ASSETS, SEED_EQUITIES, US_EQUITY_SESSION } from "./static.js";
import { fetchJson } from "../ingest/http.js";

const UNIVERSE_PATH = process.env.UNIVERSE_PATH ?? "data/universe.json";

let cached: Universe | null = null;

export function loadUniverse(): Universe {
  if (cached) return cached;
  if (existsSync(UNIVERSE_PATH)) {
    try {
      cached = Universe.parse(JSON.parse(readFileSync(UNIVERSE_PATH, "utf8")));
      return cached;
    } catch { /* fall through to seed */ }
  }
  cached = { version: "seed", generated_at: new Date().toISOString(), assets: SEED_ASSETS };
  return cached;
}

export function assetById(id: string): Asset | undefined {
  return loadUniverse().assets.find(a => a.id === id);
}

export function assetsByTag(tag: string): Asset[] {
  return loadUniverse().assets.filter(a => a.tags.includes(tag));
}

export function assetByCik(cik: string): Asset | undefined {
  const norm = cik.replace(/^0+/, "");
  return loadUniverse().assets.find(a => a.cik && a.cik.replace(/^0+/, "") === norm);
}

/**
 * Daily refresh of the equity block: top-100 by volume from Nasdaq's screener (keyless, unofficial),
 * falling back to Yahoo's most_actives, falling back to the seed. Curated tags/CIKs from the seed are
 * preserved for tickers we already know; new tickers enter with minimal tags until curated.
 */
export async function refreshUniverse(): Promise<Universe> {
  const seedMap = new Map(SEED_EQUITIES.map(a => [a.id, a]));
  let top: { symbol: string; name: string; volume: number }[] = [];

  try {
    const r = await fetchJson<any>(
      "https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=3000&offset=0&download=true",
      { headers: { accept: "application/json", "accept-language": "en-US,en;q=0.9", origin: "https://www.nasdaq.com", referer: "https://www.nasdaq.com/" } },
    );
    const rows: any[] = r?.data?.rows ?? r?.data?.table?.rows ?? [];
    top = rows
      .map(x => ({ symbol: String(x.symbol).trim(), name: String(x.name), volume: Number(String(x.volume).replace(/,/g, "")) }))
      .filter(x => x.symbol && !x.symbol.includes("^") && x.volume > 0)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 100);
  } catch (e) {
    console.warn("[universe] nasdaq screener failed:", (e as Error).message);
  }

  if (top.length < 50) {
    try {
      const r = await fetchJson<any>(
        "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=most_actives&count=100",
      );
      const quotes: any[] = r?.finance?.result?.[0]?.quotes ?? [];
      top = quotes.map(q => ({ symbol: q.symbol, name: q.shortName ?? q.longName ?? q.symbol, volume: Number(q.regularMarketVolume ?? 0) }));
    } catch (e) {
      console.warn("[universe] yahoo most_actives failed:", (e as Error).message);
    }
  }

  const equities: Asset[] = top.length >= 50
    ? top.map(t => seedMap.get(t.symbol) ?? ({
        id: t.symbol, name: t.name, class: "equity" as const, venue: "US", sessions: [US_EQUITY_SESSION], tags: ["uncurated"],
      }))
    : SEED_EQUITIES;

  // Always keep curated crypto proxies / mega caps even if they drop out of the top-100 on a quiet day
  for (const a of SEED_EQUITIES) if (!equities.find(e => e.id === a.id) && a.tags.some(t => t.startsWith("holds:") || t === "sector:crypto_proxy")) equities.push(a);

  const rest = SEED_ASSETS.filter(a => a.class !== "equity");
  const universe: Universe = {
    version: new Date().toISOString().slice(0, 10) + (top.length >= 50 ? "" : "-seed"),
    generated_at: new Date().toISOString(),
    assets: [...equities, ...rest],
  };
  mkdirSync(dirname(UNIVERSE_PATH), { recursive: true });
  writeFileSync(UNIVERSE_PATH, JSON.stringify(universe, null, 1));
  cached = universe;
  return universe;
}
