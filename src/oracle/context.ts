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
  sources: string[]; sources_unavailable: string[];
}

export function contextToPrompt(c: MarketContext): string {
  const d: Record<string, any> = {};
  for (const [k, v] of Object.entries(c)) if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) d[k] = v;
  return "MARKET CONTEXT (facts, as of " + c.as_of + "):\n" + JSON.stringify(d);
}

export interface DataProvider {
  price(symbol: string): Promise<{ spot: number | null; realized_vol_30d_ann: number | null } | null>;
  derivs(symbol: string): Promise<{ funding_8h: number | null; open_interest_usd: number | null; realized_vol_30d_ann?: number | null } | null>;
  polymarketSearch(query: string): Promise<{ yes: number | null; url: string | null; question?: string } | null>;
  calendar(days: number): Promise<{ date: string; name: string }[]>;
  events(asset: string): Promise<{ headline: string }[]>;
}

// ---------------------------------------------------------------- question parsing
const ASSETS: Record<string, string[]> = { BTC: ["bitcoin", "btc"], ETH: ["ethereum", "eth"], SOL: ["solana", "sol"], SPX: ["s&p 500", "s&p", "spx"], NDX: ["nasdaq"], GOLD: ["gold", "ouro"] };
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function detectAsset(q: string): string | null {
  const ql = q.toLowerCase();
  for (const [sym, names] of Object.entries(ASSETS)) if (names.some(n => new RegExp(`\\b${esc(n)}\\b`).test(ql))) return sym;
  return null;
}
export function detectTarget(q: string): number | null {
  const m = /(\d{1,3}(?:[,.]\d{3})+|\d+(?:\.\d+)?)\s*(k|usd|\$)?/i.exec(q.replace(/US\$/g, "$"));
  if (!m) return null;
  const raw = m[1], unit = (m[2] ?? "").toLowerCase();
  let val = /^\d{1,3}(?:[,.]\d{3})+$/.test(raw) ? Number(raw.replace(/[,.]/g, "")) : Number(raw);
  if (unit === "k") val *= 1000;
  return val >= 100 ? val : null; // ignore small numbers (dates, percentages)
}
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
    upcoming_events: [], recent_events: [], sources: [], sources_unavailable: [],
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
  }
  try { const pm = await provider.polymarketSearch(question); if (pm && pm.yes != null) { ctx.market_odds = Number(pm.yes); ctx.market_ref = pm.url ?? null; ctx.sources.push("polymarket_context"); } }
  catch (e) { ctx.sources_unavailable.push(`polymarket: ${errName(e)}`); }
  try { ctx.upcoming_events = (await provider.calendar(ctx.horizon_days ?? 45)).slice(0, 8).map(e => `${e.date}: ${e.name}`); if (ctx.upcoming_events.length) ctx.sources.push("calendar"); }
  catch (e) { ctx.sources_unavailable.push(`calendar: ${errName(e)}`); }
  return ctx;
}

// ---------------------------------------------------------------- providers
const STOP = new Set(["will", "close", "above", "below", "before", "between"]);
const words = (s: string) => new Set((s.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter(w => !STOP.has(w)));
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
    const j: any = await tools.polymarketTop({ sort: "volume_24h", limit: 50 });
    const qw = words(query); let best: any = null, score = 0;
    for (const m of j.markets ?? []) { const s = [...words(m.question ?? "")].filter(w => qw.has(w)).length; if (s > score) { best = m; score = s; } }
    return best && score >= 3 ? { yes: best.yes_prob, url: best.url, question: best.question } : null;
  },
  async calendar(days) {
    const c: any = tools.calendar({ days: Math.max(1, Math.min(60, days)) });
    return (c.items ?? []).map((e: any) => ({ date: String(e.at).slice(0, 10), name: e.name }));
  },
  async events(asset) {
    const r: any = tools.impactFor({ asset_id: UNIVERSE_ID[asset] ?? asset, since: "7d", limit: 5 });
    return (r.top ?? []).map((e: any) => ({ headline: e.title }));
  },
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
