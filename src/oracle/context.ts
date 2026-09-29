/** Market context injector (v0.3) — 1:1 port of realidade2/context.py. This is the "data connector" that kills the
 *  coin-flip attractor: the oracle never simulates blind. Inside Intel the provider calls the tool functions directly
 *  (priceFor, derivsFor, polymarketTop, calendar, impactFor) — no HTTP, no billing hop. Source failures become
 *  `sources_unavailable`, never errors. */
import * as tools from "../server/tools.js";

export interface MarketContext {
  as_of: string;
  asset: string | null; spot: number | null; target: number | null;
  distance_pct: number | null;           // (target/spot - 1) * 100
  horizon_days: number | null;
  realized_vol_30d_ann: number | null;   // e.g. 0.55 = 55 % annualised
  implied_move_pct: number | null;       // vol * sqrt(h/365) * 100 — one-sigma move over the horizon
  z_to_target: number | null;            // distance / implied move (in sigmas)
  funding_8h: number | null; open_interest_usd: number | null;
  market_odds: number | null;            // Polymarket YES price for the same question, if any
  market_ref: string | null;
  base_rate: number | null;              // historical frequency of this kind of move (or of the event)
  base_rate_note: string;
  upcoming_events: string[]; recent_events: string[];
  extra: Record<string, unknown>;        // additional grounded facts (Selic/Focus, SPX, total market cap, SOL/ETH vols…) — see extraFacts()
  sources: string[]; sources_unavailable: string[];
}

export function contextToPrompt(c: MarketContext): string {
  const d: Record<string, any> = {};
  for (const [k, v] of Object.entries(c)) if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0) && !(k === "extra" && Object.keys(v as object).length === 0)) d[k] = v;
  return "MARKET CONTEXT (facts, as of " + c.as_of + "):\n" + JSON.stringify(d);
}

export interface DataProvider {
  price(symbol: string): Promise<{ spot: number | null; realized_vol_30d_ann: number | null } | null>;
  derivs(symbol: string): Promise<{ funding_8h: number | null; open_interest_usd: number | null; realized_vol_30d_ann?: number | null } | null>;
  polymarketSearch(query: string): Promise<{ yes: number | null; url: string | null; question?: string } | null>;
  calendar(days: number): Promise<{ date: string; name: string }[]>;
  events(asset: string): Promise<{ headline: string }[]>;
  /** Optional grounded facts for questions the price/derivs path cannot ground: Selic (BCB SGS + Focus), SPX close + vol, total crypto market cap, SOL/ETH realized vols. */
  extraFacts?(question: string, ctx: { asset: string | null; horizon_days: number | null }): Promise<{ facts: Record<string, unknown>; sources: string[]; unavailable: string[]; market_odds?: number | null; market_ref?: string | null; base_rate?: number | null; base_rate_note?: string }>;
}

// ---------------------------------------------------------------- question parsing
const ASSETS: Record<string, string[]> = { BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"], SOL: ["solana", "sol"], SPX: ["s&p 500", "s&p", "spx"], NDX: ["nasdaq"], GOLD: ["gold", "ouro"] };
const ASSET_PRIORITY = ["SPX", "NDX", "GOLD", "BTC", "ETH", "SOL"]; // "S&P 500 … Bitcoin" style questions: index first
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function detectAsset(q: string): string | null {
  const ql = q.toLowerCase();
  for (const sym of ASSET_PRIORITY) if (ASSETS[sym].some(n => new RegExp(`\\b${esc(n)}\\b`).test(ql))) return sym;
  return null;
}
const BELOW_WORDS = /\b(below|under|beneath|less than|lower than|abaixo|menor que)\b/;
const ABOVE_WORDS = /\b(above|over|exceed\w*|higher than|more than|acima|maior que)\b/;
/** Remove ISO dates, month-year and bare years so they are never mistaken for a price target (context.py v0.3.1 `_strip_dates`). */
function stripDates(q: string): string {
  return q.replace(/\b20\d{2}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?\s*(19|20)\d{2}\b/gi, " ")
    .replace(/\b(19|20)\d{2}\b/g, " ")
    .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, " ");
}
/** First money-like number in the question (context.py v0.3.1 `detect_target`): dates and years are stripped first;
 *  a number with an explicit unit ($/usd/k or thousands grouping) is accepted from 10 up, without unit from 100. */
export function detectTarget(q: string): number | null {
  const cleaned = stripDates(q.replace(/US\$/g, "$"));
  const re = /(\$\s*)?(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k\b|usd\b|\$)?/gi;
  for (const m of cleaned.matchAll(re)) {
    const pre = m[1], raw = m[2], unit = (m[3] ?? "").toLowerCase();
    const grouped = /^\d{1,3}(?:[,.]\d{3})+$/.test(raw);
    let val = grouped ? Number(raw.replace(/[,.]/g, "")) : Number(raw);
    if (unit.startsWith("k")) val *= 1000;
    const hasUnit = Boolean(pre) || Boolean(unit) || grouped;
    if ((hasUnit && val >= 10) || val >= 100) return val;
  }
  return null;
}
/** 'below' when the question asks about falling under a level and never mentions above; else 'above'. */
export function detectDirection(q: string): "above" | "below" { const ql = q.toLowerCase(); return BELOW_WORDS.test(ql) && !ABOVE_WORDS.test(ql) ? "below" : "above"; }
export function detectHorizonDays(q: string, now: Date): number | null {
  const m = /(20\d{2})-(\d{2})-(\d{2})/.exec(q);
  if (!m) return null;
  const dt = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.max(1, Math.floor((dt - now.getTime()) / 86_400_000));
}

// ---------------------------------------------------------------- base rates
function erf(x: number): number { // Abramowitz-Stegun 7.1.26, |err| < 1.5e-7
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return s * y;
}
/** Probability a lognormal walk ends above (or, if `touch`, touches) a threshold. Reference class, not a forecast:
 *  it is what the market's own volatility implies with zero directional view. */
export function baseRateThreshold(distancePct: number | null, volAnn: number | null, horizonDays: number | null, touch = false): [number | null, string] {
  if (distancePct == null || !volAnn || !horizonDays) return [null, "insufficient data for a volatility base rate"];
  const sigma = volAnn * Math.sqrt(horizonDays / 365);
  const z = Math.log(1 + distancePct / 100) / sigma;
  const pEnd = 0.5 * (1 - erf(z / Math.SQRT2));
  if (touch && distancePct > 0) {
    const p = Math.min(1, 2 * pEnd); // reflection principle: P(max > b) = 2 P(S_T > b) for a driftless walk
    return [round3(p), `driftless lognormal touch probability; z=${z.toFixed(2)} sigmas over ${horizonDays}d`];
  }
  return [round3(pEnd), `driftless lognormal end-above probability; z=${z.toFixed(2)} sigmas over ${horizonDays}d`];
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const round2 = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------- builder
export async function buildContext(question: string, provider: DataProvider | null, now = new Date()): Promise<MarketContext> {
  const ctx: MarketContext = {
    as_of: now.toISOString().slice(0, 16).replace("T", " ") + " UTC",
    asset: detectAsset(question), spot: null, target: detectTarget(question), distance_pct: null,
    horizon_days: detectHorizonDays(question, now), realized_vol_30d_ann: null, implied_move_pct: null, z_to_target: null,
    funding_8h: null, open_interest_usd: null, market_odds: null, market_ref: null, base_rate: null, base_rate_note: "",
    upcoming_events: [], recent_events: [], extra: {}, sources: [], sources_unavailable: [],
  };
  const touch = /at any point|touch|intraday|em algum momento|new all-time high/i.test(question);
  if (!provider) { ctx.sources_unavailable.push("no data provider configured"); return ctx; }
  const errName = (e: unknown) => (e instanceof Error ? e.constructor.name + (e.message ? `: ${e.message.slice(0, 60)}` : "") : String(e));

  if (ctx.asset) {
    try { const p = await provider.price(ctx.asset); if (p) { ctx.spot = p.spot; ctx.realized_vol_30d_ann = p.realized_vol_30d_ann; ctx.sources.push("price_for"); } }
    catch (e) { ctx.sources_unavailable.push(`price_for: ${errName(e)}`); }
    try { const d = await provider.derivs(ctx.asset); if (d) { ctx.funding_8h = d.funding_8h; ctx.open_interest_usd = d.open_interest_usd; ctx.realized_vol_30d_ann = ctx.realized_vol_30d_ann ?? d.realized_vol_30d_ann ?? null; ctx.sources.push("derivs_for"); } }
    catch (e) { ctx.sources_unavailable.push(`derivs_for: ${errName(e)}`); }
    try { ctx.recent_events = (await provider.events(ctx.asset)).slice(0, 5).map(e => (e.headline ?? "").slice(0, 120)); if (ctx.recent_events.length) ctx.sources.push("impact_for"); }
    catch (e) { ctx.sources_unavailable.push(`impact_for: ${errName(e)}`); }
  }
  if (ctx.spot && ctx.target) {
    ctx.distance_pct = round2((ctx.target / ctx.spot - 1) * 100);
    if (ctx.realized_vol_30d_ann && ctx.horizon_days) {
      const s = ctx.realized_vol_30d_ann * Math.sqrt(ctx.horizon_days / 365);
      ctx.implied_move_pct = round2(s * 100);
      ctx.z_to_target = round2(Math.log(1 + ctx.distance_pct / 100) / s);
    }
    [ctx.base_rate, ctx.base_rate_note] = baseRateThreshold(ctx.distance_pct, ctx.realized_vol_30d_ann, ctx.horizon_days, touch);
    if (detectDirection(question) === "below" && ctx.base_rate != null) {  // deviation #2 (v0.3.1)
      if (touch) { // touch-below: reflect the other way — P(min < b) = 2 P(S_T < b) for b below spot
        const pEndBelow = 1 - (baseRateThreshold(ctx.distance_pct, ctx.realized_vol_30d_ann, ctx.horizon_days, false)[0] ?? 0);
        ctx.base_rate = round3(Math.min(1, 2 * pEndBelow));
      } else ctx.base_rate = round3(1 - ctx.base_rate);
      ctx.base_rate_note = "complement (question asks BELOW); " + ctx.base_rate_note;
    }
  }
  try { const pm = await provider.polymarketSearch(question); if (pm && pm.yes != null) { ctx.market_odds = Number(pm.yes); ctx.market_ref = pm.url ?? null; ctx.sources.push("polymarket_context"); } }
  catch (e) { ctx.sources_unavailable.push(`polymarket: ${errName(e)}`); }
  try { ctx.upcoming_events = (await provider.calendar(ctx.horizon_days ?? 45)).slice(0, 8).map(e => `${e.date}: ${e.name}`); if (ctx.upcoming_events.length) ctx.sources.push("calendar"); }
  catch (e) { ctx.sources_unavailable.push(`calendar: ${errName(e)}`); }
  if (provider.extraFacts) {
    try {
      const x = await provider.extraFacts(question, { asset: ctx.asset, horizon_days: ctx.horizon_days });
      Object.assign(ctx.extra, x.facts); ctx.sources.push(...x.sources); ctx.sources_unavailable.push(...x.unavailable);
      if (ctx.market_odds == null && x.market_odds != null) { ctx.market_odds = x.market_odds; ctx.market_ref = x.market_ref ?? null; }
      if (ctx.base_rate == null && x.base_rate != null) { ctx.base_rate = x.base_rate; ctx.base_rate_note = x.base_rate_note ?? "from extra facts"; }
    } catch (e) { ctx.sources_unavailable.push(`extra: ${errName(e)}`); }
  }
  return ctx;
}

// ---------------------------------------------------------------- prediction-market matching (deviation #4, context.py v0.3.1)
export const SYNONYMS: Record<string, string[]> = {  // canonical token <- variants; matching happens on canonical tokens
  fed: ["fed", "fomc", "federal", "reserve", "powell"],
  cut: ["cut", "cuts", "decrease", "decreases", "lower", "lowers", "reduce", "ease", "easing"],
  hike: ["hike", "hikes", "raise", "raises", "increase", "increases", "tighten"],
  hold: ["hold", "holds", "unchanged", "pause", "change"],
  rate: ["rate", "rates", "bps", "basis", "funds"],
  btc: ["btc", "bitcoin"], eth: ["eth", "ethereum"], sol: ["sol", "solana"],
  ecb: ["ecb", "lagarde"], boj: ["boj", "japan"], copom: ["copom", "selic", "bcb"],
  cpi: ["cpi", "inflation"], gdp: ["gdp", "recession"], election: ["election", "wins", "win", "president"],
  oct: ["oct", "october", "outubro"], nov: ["nov", "november", "novembro"], dec: ["dec", "december", "dezembro"],
  sep: ["sep", "september", "setembro"], jan: ["jan", "january"],
};
const CANON = new Map<string, string>(); for (const [k, vs] of Object.entries(SYNONYMS)) for (const v of vs) CANON.set(v, k);
const STOP = new Set(["will", "the", "than", "after", "before", "between", "meeting", "close", "above", "below", "over", "under", "trade", "point", "reach", "hit", "price", "usd", "any", "its", "this", "that", "with", "from", "into", "2026", "2027"]);
const EVENT_TAGS = new Set(["fed", "ecb", "boj", "copom", "cpi", "gdp", "election", "btc", "eth", "sol"]);
const MONTHS = new Set(["jan", "sep", "oct", "nov", "dec"]);
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) { if (STOP.has(w) || w.length < 3) continue; out.add(CANON.get(w) ?? w); }
  return out;
}
const inter = (a: Set<string>, b: Set<string>) => [...a].filter(x => b.has(x));
/** Best Polymarket market for the question: canonical-token Jaccard, with a hard requirement that the EVENT tag (fed, btc,
 *  copom…) and the month agree when both sides have one; direction words (cut/hike/hold) are decisive. Returns null below
 *  the threshold — a wrong match is worse than no match. */
export function matchMarket(question: string, markets: { question?: string; title?: string; yes?: number | null; yes_prob?: number | null; url?: string | null }[]): { yes: number | null; url: string | null; question?: string; score: number } | null {
  const qt = tokens(question);
  const qEvents = new Set(inter(qt, EVENT_TAGS)), qMonths = new Set(inter(qt, MONTHS));
  let best: any = null, bestScore = 0;
  for (const m of markets) {
    let mt = tokens(m.question ?? m.title ?? "");
    if (!mt.size) continue;
    if (qEvents.size && !inter(qEvents, mt).length) continue;
    const mMonths = new Set(inter(mt, MONTHS));
    if (qMonths.size && mMonths.size && !inter(qMonths, mMonths).length) continue;
    for (const [a, b] of [["cut", "hike"], ["cut", "hold"], ["hike", "hold"]] as const) {
      if ((qt.has(a) && mt.has(b) && !mt.has(a)) || (qt.has(b) && mt.has(a) && !mt.has(b))) { mt = new Set(); break; }
    }
    if (!mt.size) continue;
    const i = inter(qt, mt).length, u = new Set([...qt, ...mt]).size;
    const score = i / u + 0.15 * inter(qEvents, mt).length;
    if (score > bestScore) { best = m; bestScore = score; }
  }
  if (best && bestScore >= 0.30) return { yes: best.yes ?? best.yes_prob ?? null, url: best.url ?? null, question: best.question, score: Math.round(bestScore * 1000) / 1000 };
  return null;
}

// ---------------------------------------------------------------- providers
/** Intel's own tool functions, called in-process. Universe ids differ for a few assets (GOLD → GC). */
const UNIVERSE_ID: Record<string, string> = { GOLD: "GC" };
export const intelProvider: DataProvider = {
  async price(symbol) {
    const p: any = await tools.priceFor({ symbol });
    return { spot: p.spot?.price ?? p.perp?.mark ?? null, realized_vol_30d_ann: p.realized_vol_30d_ann ?? null };
  },
  async derivs(symbol) {
    const d: any = await tools.derivsFor({ symbol, since: "24h" });
    return { funding_8h: d.funding?.rate_8h_equiv ?? null, open_interest_usd: d.open_interest?.usd ?? null };
  },
  async polymarketSearch(query) {
    // Top by volume plus a tag pull for the question's event (fed, crypto…) so a relevant market is in the candidate set even
    // when it is not in the top-50 by volume.
    const ql = query.toLowerCase();
    const tag = /\b(fed|fomc|federal reserve|powell)\b/.test(ql) ? "fed" : /\b(btc|bitcoin|eth|ethereum|sol|solana|crypto)\b/.test(ql) ? "crypto" : /\b(cpi|inflation|gdp|recession)\b/.test(ql) ? "economy" : null;
    const [top, tagged] = await Promise.all([tools.polymarketTop({ sort: "volume_24h", limit: 50 }), tag ? tools.polymarketTop({ sort: "volume_24h", limit: 50, tag }).catch(() => ({ markets: [] })) : Promise.resolve({ markets: [] } as any)]);
    const seen = new Set<string>(); const cands: any[] = [];
    for (const m of [...((tagged as any).markets ?? []), ...((top as any).markets ?? [])]) if (m.slug && !seen.has(m.slug)) { seen.add(m.slug); cands.push(m); }
    return matchMarket(query, cands);
  },
  async calendar(days) {
    const c: any = tools.calendar({ days: Math.max(1, Math.min(60, days)) });
    return (c.items ?? []).map((e: any) => ({ date: String(e.at).slice(0, 10), name: e.name }));
  },
  async events(asset) {
    const r: any = tools.impactFor({ asset_id: UNIVERSE_ID[asset] ?? asset, since: "7d", limit: 5 });
    return (r.top ?? []).map((e: any) => ({ headline: e.title }));
  },
  async extraFacts(question, ctx) { const { extraFactsFor } = await import("./sources.js"); return extraFactsFor(question, ctx); },
};
/** Deterministic numbers for tests and offline runs (same values as the Python MockProvider). */
export const mockProvider: DataProvider = {
  async price(symbol) { return ({ BTC: { spot: 109_500, realized_vol_30d_ann: 0.42 }, ETH: { spot: 3_950, realized_vol_30d_ann: 0.62 }, SOL: { spot: 205, realized_vol_30d_ann: 0.80 } } as Record<string, any>)[symbol] ?? null; },
  async derivs() { return { funding_8h: 0.0001, open_interest_usd: 12_000_000_000 }; },
  async polymarketSearch(q) { const ql = q.toLowerCase(); return ql.includes("federal reserve") || ql.includes("fed") ? { yes: 0.71, url: "https://polymarket.com/event/fed-october-2026", question: "Fed cuts in October?" } : null; },
  async calendar() { return [{ date: "2026-10-10", name: "US CPI (Sep)" }, { date: "2026-10-29", name: "FOMC decision" }]; },
  async events(asset) { return [{ headline: `${asset}: spot ETF net inflows 3 days in a row` }]; },
};
/** Injectable for tests (same pattern as tools._ext). */
export const _provider = { current: (process.env.R2_MOCK === "1" ? mockProvider : intelProvider) as DataProvider, reset() { this.current = process.env.R2_MOCK === "1" ? mockProvider : intelProvider; } };
