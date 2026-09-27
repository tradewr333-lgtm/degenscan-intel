import type { Connector } from "../base.js";
import { src, clamp, ent } from "../base.js";
import { fetchJson } from "../http.js";
import type { RawEvent } from "../../schema.js";
import { loadUniverse } from "../../universe/index.js";

/* ───────────────────────── Crypto ───────────────────────── */

/** DefiLlama hacks — the fastest structured feed of exploits. */
export const llamaHacks: Connector = {
  id: "llama-hacks", name: "DefiLlama Hacks", tier: "aggregator", cadence_s: 120, url: "https://defillama.com/hacks",
  async run() {
    const r = await fetchJson<any[]>("https://api.llama.fi/hacks");
    const cutoff = Date.now() / 1000 - 3 * 86_400;
    return r.filter(h => h.date >= cutoff).map((h): RawEvent => ({
      native_id: `${h.name}-${h.date}`, ts_event: new Date(h.date * 1000).toISOString(), source: src(llamaHacks), kind: "crypto.hack",
      title: `Exploit: ${h.name} — $${(h.amount / 1e6).toFixed(1)}M (${h.classification ?? h.technique ?? "unknown"})`,
      summary: `${h.name} on ${Array.isArray(h.chain) ? h.chain.join("/") : h.chain}: ${h.technique ?? ""}. Amount lost ≈ $${Number(h.amount).toLocaleString()}.`,
      entities: chainEntities(h.chain), text_hints: [String(h.name), String(h.chain)],
      severity: clamp(Math.log10(Math.max(1, h.amount)) / 9), novelty: 0.9, raw_ref: h.source ?? "https://defillama.com/hacks", meta: { amount_usd: h.amount },
    }));
  },
};
function chainEntities(chain: string | string[]) {
  const cs = (Array.isArray(chain) ? chain : [chain]).map(String);
  const map: Record<string, string> = { Ethereum: "ETH", Solana: "SOL", BSC: "BNB", "Binance": "BNB", Tron: "TRX", Avalanche: "AVAX", Sui: "SUI", Hyperliquid: "HYPE", Bitcoin: "BTC" };
  return cs.map(c => map[c]).filter(Boolean).map(id => ent("asset", `asset:${id}`, id, 0.6));
}

/** CoinGecko — detect abnormal 1h moves in universe coins (crypto.onchain as a generic "market shock" kind). */
export const coingeckoMoves: Connector = {
  id: "coingecko-moves", name: "CoinGecko abnormal moves", tier: "aggregator", cadence_s: 300, url: "https://www.coingecko.com/en/api",
  async run() {
    const ids = loadUniverse().assets.filter(a => a.coingecko_id).map(a => a.coingecko_id!).join(",");
    const r = await fetchJson<any[]>(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=1h,24h`);
    const hour = new Date().toISOString().slice(0, 13);
    return r.filter(c => Math.abs(c.price_change_percentage_1h_in_currency ?? 0) >= 3).map((c): RawEvent => {
      const pct = c.price_change_percentage_1h_in_currency as number;
      const sym = String(c.symbol).toUpperCase();
      return {
        native_id: `${sym}-${hour}`, ts_event: new Date().toISOString(), source: src(coingeckoMoves), kind: pct < 0 ? "crypto.liquidation_cascade" : "crypto.onchain",
        title: `${sym} ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% in 1h (24h ${Number(c.price_change_percentage_24h_in_currency ?? 0).toFixed(1)}%)`,
        summary: `${c.name} moved ${pct.toFixed(2)}% in the last hour to $${c.current_price}. 24h volume $${Number(c.total_volume).toLocaleString()}.`,
        entities: [ent("asset", `asset:${sym}`, sym)], severity: clamp(Math.abs(pct) / 15), novelty: 0.7, raw_ref: `https://www.coingecko.com/en/coins/${c.id}`,
      };
    });
  },
};

/** Stablecoin supply deltas (mint/burn) from DefiLlama — liquidity signal. */
export const stablecoinSupply: Connector = {
  id: "stablecoin-supply", name: "Stablecoin supply (DefiLlama)", tier: "aggregator", cadence_s: 1800, url: "https://defillama.com/stablecoins",
  async run() {
    const r = await fetchJson<any>("https://stablecoins.llama.fi/stablecoins?includePrices=true");
    const out: RawEvent[] = [];
    for (const s of (r.peggedAssets ?? []).filter((x: any) => ["USDT", "USDC"].includes(x.symbol))) {
      const now = Number(s.circulating?.peggedUSD ?? 0), prev = Number(s.circulatingPrevDay?.peggedUSD ?? now);
      const delta = now - prev;
      if (Math.abs(delta) < 500e6 && Math.abs(Number(s.price ?? 1) - 1) < 0.005) continue;
      const depeg = Math.abs(Number(s.price ?? 1) - 1) >= 0.005;
      out.push({
        native_id: `${s.symbol}-${new Date().toISOString().slice(0, 10)}`, ts_event: new Date().toISOString(), source: src(stablecoinSupply),
        kind: depeg ? "crypto.outage" : "crypto.stablecoin_mint",
        title: depeg ? `${s.symbol} trading at $${Number(s.price).toFixed(4)} — depeg watch` : `${s.symbol} supply ${delta > 0 ? "+" : ""}$${(delta / 1e9).toFixed(2)}B in 24h`,
        summary: `${s.name} circulating $${(now / 1e9).toFixed(1)}B (24h Δ $${(delta / 1e9).toFixed(2)}B), price $${s.price}.`,
        entities: [ent("asset", `asset:${s.symbol}`, s.symbol)], severity: depeg ? 0.9 : clamp(Math.abs(delta) / 3e9), novelty: depeg ? 0.95 : 0.4, raw_ref: "https://defillama.com/stablecoins",
      });
    }
    return out;
  },
};

/** Binance listings/delistings announcements. */
export const binanceAnnouncements: Connector = {
  id: "binance-announcements", name: "Binance Announcements", tier: "primary", cadence_s: 300, url: "https://www.binance.com/en/support/announcement",
  async run() {
    const r = await fetchJson<any>("https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=20");
    const arts: any[] = (r?.data?.catalogs ?? []).flatMap((c: any) => c.articles ?? []);
    return arts.filter(a => /will list|delist|launchpool|new listing/i.test(a.title)).map((a): RawEvent => ({
      native_id: String(a.code), ts_event: new Date(a.releaseDate).toISOString(), source: src(binanceAnnouncements), kind: /delist/i.test(a.title) ? "crypto.outage" : "crypto.listing",
      title: a.title, summary: a.title, text_hints: [a.title], severity: 0.4, novelty: 0.8, raw_ref: `https://www.binance.com/en/support/announcement/${a.code}`,
    }));
  },
};

/** Coinbase status — incidents on the biggest US venue. */
export const coinbaseStatus: Connector = {
  id: "coinbase-status", name: "Coinbase Status", tier: "primary", cadence_s: 120, url: "https://status.coinbase.com",
  async run() {
    const r = await fetchJson<any>("https://status.coinbase.com/api/v2/summary.json");
    return (r.incidents ?? []).filter((i: any) => i.status !== "resolved").map((i: any): RawEvent => ({
      native_id: i.id, ts_event: i.created_at, source: src(coinbaseStatus), kind: "crypto.outage",
      title: `Coinbase incident: ${i.name} (${i.impact})`, summary: String(i.incident_updates?.[0]?.body ?? "").slice(0, 400),
      entities: [ent("company", "company:COIN", "Coinbase"), ent("asset", "asset:BTC", "BTC", 0.4)], severity: i.impact === "critical" ? 0.8 : i.impact === "major" ? 0.6 : 0.3, novelty: 0.7, raw_ref: i.shortlink,
    }));
  },
};

/** mempool.space — fee spikes = on-chain congestion / demand shock. */
export const mempool: Connector = {
  id: "mempool", name: "mempool.space fees", tier: "primary", cadence_s: 300, url: "https://mempool.space",
  async run() {
    const f = await fetchJson<any>("https://mempool.space/api/v1/fees/recommended");
    if (f.fastestFee < 100) return [];
    return [{
      native_id: `fees-${new Date().toISOString().slice(0, 13)}`, ts_event: new Date().toISOString(), source: src(mempool), kind: "crypto.onchain",
      title: `Bitcoin fee spike: ${f.fastestFee} sat/vB next block`, summary: `Recommended fees: fastest ${f.fastestFee}, 30min ${f.halfHourFee}, 1h ${f.hourFee} sat/vB.`,
      entities: [ent("asset", "asset:BTC", "BTC")], severity: clamp(f.fastestFee / 500), novelty: 0.6, raw_ref: "https://mempool.space",
    }];
  },
};

/* ───────────────────────── Prediction markets & macro price of events ───────────────────────── */

const WATCH_TERMS = /fed|rate cut|rate hike|recession|shutdown|tariff|bitcoin|ethereum|solana|nvidia|tesla|apple|microsoft|openai|election|iran|taiwan|china|ceasefire|oil|opec|sec |etf|stablecoin|powell|cpi|inflation/i;

/** Polymarket — market-implied probability shifts on macro/geo/crypto questions. Stateless: reports current state; the store dedupes hourly. */
export const polymarket: Connector = {
  id: "polymarket", name: "Polymarket (event prices)", tier: "aggregator", cadence_s: 600, url: "https://polymarket.com",
  async run() {
    const r = await fetchJson<any[]>("https://gamma-api.polymarket.com/markets?limit=200&active=true&closed=false&order=volume24hr&ascending=false");
    const hour = new Date().toISOString().slice(0, 13);
    return r.filter(m => WATCH_TERMS.test(m.question) && Number(m.volume24hr ?? 0) > 50_000).slice(0, 40).map((m): RawEvent => {
      const prices: number[] = safeJson(m.outcomePrices) ?? [];
      const outcomes: string[] = safeJson(m.outcomes) ?? [];
      const yes = prices[0] ?? 0;
      const chg = Number(m.oneDayPriceChange ?? 0);
      return {
        native_id: `${m.id}-${hour}`, ts_event: new Date().toISOString(), source: src(polymarket), kind: "mkt.prediction_shift",
        title: `Polymarket: "${m.question}" → ${outcomes[0] ?? "Yes"} ${(yes * 100).toFixed(0)}% (${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(0)} pts/24h)`,
        summary: `24h volume $${Number(m.volume24hr).toLocaleString()}. Outcomes ${outcomes.join("/")} at ${prices.map(p => (p * 100).toFixed(0) + "%").join("/")}. Ends ${m.endDate}.`,
        text_hints: [m.question], severity: clamp(Math.abs(chg) * 4), novelty: clamp(Math.abs(chg) * 5), raw_ref: `https://polymarket.com/event/${m.slug ?? m.id}`,
        meta: { yes_prob: yes, change_24h: chg, volume24h: m.volume24hr },
      };
    });
  },
};
function safeJson(s: unknown) { try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return undefined; } }

/** GDELT DOC API — global article volume for hot entities (attention). Rate-limited; keep small. */
export const gdeltDoc: Connector = {
  id: "gdelt-doc", name: "GDELT DOC (global coverage)", tier: "aggregator", cadence_s: 900, url: "https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/",
  async run() {
    const queries: [string, string[]][] = [["Taiwan Strait", ["country:TW"]], ["Strait of Hormuz", ["country:IR"]], ["OPEC", ["commodity:CL"]]];
    const out: RawEvent[] = [];
    for (const [q, nodes] of queries) {
      try {
        const r = await fetchJson<any>(`https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=artlist&maxrecords=10&format=json&timespan=1h&sort=datedesc`, { timeoutMs: 12_000 });
        const arts: any[] = r.articles ?? [];
        if (arts.length < 8) continue;                        // only when coverage is dense
        out.push({
          native_id: `${q}-${new Date().toISOString().slice(0, 13)}`, ts_event: new Date().toISOString(), source: src(gdeltDoc), kind: "media.spike",
          title: `Global coverage spike: "${q}" — ${arts.length}+ articles in 1h`, summary: arts.slice(0, 3).map(a => a.title).join(" | ").slice(0, 500),
          entities: nodes.map(n => ({ type: n.split(":")[0] as any, id: n, name: n.split(":")[1], confidence: 0.6 })), severity: 0.3, novelty: 0.5, raw_ref: arts[0]?.url ?? "",
        });
      } catch { /* GDELT throttles hard; skip */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    return out;
  },
};

export const CRYPTO_MARKETS: Connector[] = [llamaHacks, coingeckoMoves, stablecoinSupply, binanceAnnouncements, coinbaseStatus, mempool, polymarket, gdeltDoc];
