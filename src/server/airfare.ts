/**
 * Airfare benchmark (08/11, Renato — "7 prompts that break airline pricing" post). The prompts make a chatbot invent
 * prices; this tool answers the honest part of those questions with the PRIMARY public source instead:
 * the U.S. DOT Domestic Airline Consumer Airfare Report (Office of Aviation Analysis, built from the airlines' own
 * Origin & Destination survey; public domain, quarterly since 1993, ~7,000 domestic city-pair markets).
 *  - Table 1a (tfrh-tu9e): airport-pair markets in multi-airport cities → average fare per airport pair, largest and
 *    lowest-fare carrier with market share. Gives the "nearby airport" comparison (e.g. MIA vs FLL, JFK vs LGA vs EWR).
 *  - Table 6 (yj5y-b2ir): city-pair markets with ≥10 passengers/day → fallback when the airport pair is not in 1a.
 * Average fare PAID (each way, incl. taxes and first class), not a live price; data lags the quarter by ~5–6 months.
 * We do not scrape booking sites or resell GDS / OTA fares.
 */
import { UA } from "../ingest/http.js";

const DOT = "https://data.transportation.gov/resource/";
const T1A = "tfrh-tu9e", T6 = "yj5y-b2ir";
const memo = new Map<string, { at: number; v: any }>();
export const _air = { reset() { memo.clear(); }, fetch: (u: string) => fetch(u, { headers: { "user-agent": `${UA} (contact@degenscan.io)`, accept: "application/json" }, signal: AbortSignal.timeout(20_000) }) };

async function soql(id: string, where: string, limit = 48, order = "year DESC, quarter DESC"): Promise<any[]> {
  const url = `${DOT}${id}.json?$where=${encodeURIComponent(where)}&$order=${encodeURIComponent(order)}&$limit=${limit}`;
  const c = memo.get(url); if (c && Date.now() - c.at < 24 * 3600_000) return c.v;
  try {
    const res = await _air.fetch(url);
    if (!res.ok) throw Object.assign(new Error(`data.transportation.gov ${res.status}`), { status: 502 });
    const v = await res.json() as any[]; memo.set(url, { at: Date.now(), v }); return v;
  } catch (e) { if (c) return c.v; throw e; }
}

export const CARRIERS: Record<string, string> = {
  AA: "American", DL: "Delta", UA: "United", WN: "Southwest", B6: "JetBlue", AS: "Alaska", NK: "Spirit", F9: "Frontier",
  G4: "Allegiant", SY: "Sun Country", HA: "Hawaiian", MX: "Breeze", XP: "Avelo", VX: "Virgin America", US: "US Airways", FL: "AirTran",
};
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = (v: number | null) => v == null ? null : Math.round(v * 100) / 100;
const pctOf = (a: number | null, b: number | null) => a == null || b == null || !b ? null : Math.round((a / b - 1) * 1000) / 10;
const carrier = (code: unknown, share: unknown, fare: unknown) => code ? { code: String(code), name: CARRIERS[String(code)] ?? null, market_share_pct: share == null ? null : Math.round(Number(share) * 1000) / 10, avg_fare: r2(num(fare)) } : null;

/** Pure: a DOT row (Table 1a or 6) → normalised market. Exported for tests. */
export function normFare(r: any) {
  return {
    period: `${r.year}Q${r.quarter}`, year: Number(r.year), quarter: Number(r.quarter),
    airport_1: r.airport_1 ?? null, airport_2: r.airport_2 ?? null, city_1: r.city1 ?? null, city_2: r.city2 ?? null,
    citymarket_1: r.citymarketid_1 ?? null, citymarket_2: r.citymarketid_2 ?? null,
    miles: num(r.nsmiles), passengers_per_day: r2(num(r.passengers)), avg_fare: r2(num(r.fare)),
    largest_carrier: carrier(r.carrier_lg, r.large_ms, r.fare_lg), lowest_fare_carrier: carrier(r.carrier_low, r.lf_ms, r.fare_low),
  };
}
type Mkt = ReturnType<typeof normFare>;

/** Pure: history (newest first) + same-quarter airport alternatives → benchmark. Exported for tests. */
export function airfareSummary(hist: Mkt[], alts: Mkt[], from: string, to: string, level: "airport_pair" | "city_pair") {
  const h = [...hist].sort((a, b) => b.year - a.year || b.quarter - a.quarter);
  const latest = h[0];
  const ly = h.find(x => x.year === latest.year - 1 && x.quarter === latest.quarter) ?? null;
  const recent = h.filter(x => x.year * 4 + x.quarter > latest.year * 4 + latest.quarter - 12);   // last 3 years
  const byQ: Record<number, number[]> = {};
  for (const x of recent) if (x.avg_fare != null) (byQ[x.quarter] ??= []).push(x.avg_fare);
  const qAvg = Object.entries(byQ).map(([q, v]) => ({ quarter: Number(q), months: ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][Number(q) - 1], avg_fare: r2(v.reduce((s, x) => s + x, 0) / v.length), n: v.length }))
    .sort((a, b) => a.quarter - b.quarter);
  const seasonality = qAvg.length >= 3 ? (() => {
    const s = [...qAvg].sort((a, b) => (a.avg_fare ?? 0) - (b.avg_fare ?? 0));
    return { by_quarter: qAvg, cheapest_quarter: s[0], priciest_quarter: s[s.length - 1], spread_pct: pctOf(s[s.length - 1].avg_fare, s[0].avg_fare), window: "last 3 years of travel quarters" };
  })() : null;
  const lg = latest.largest_carrier, lo = latest.lowest_fare_carrier;
  const lowFare = lo && lg && lo.code !== lg.code ? { carrier: lo, vs_largest_carrier_pct: pctOf(lo.avg_fare, lg.avg_fare) } : null;
  const same = (m: Mkt) => [m.airport_1, m.airport_2].sort().join("-") === [from, to].sort().join("-");
  const nearby = alts.filter(a => a.avg_fare != null).sort((a, b) => (a.avg_fare ?? 0) - (b.avg_fare ?? 0))
    .map(a => ({ airports: `${a.airport_1}–${a.airport_2}`, avg_fare: a.avg_fare, vs_requested_pct: level === "airport_pair" ? pctOf(a.avg_fare, latest.avg_fare) : null,
      passengers_per_day: a.passengers_per_day, largest_carrier: a.largest_carrier?.code ?? null, requested: same(a) }));
  const cheaper = level === "airport_pair" ? nearby.find(n => !n.requested && n.avg_fare != null && latest.avg_fare != null && n.avg_fare < latest.avg_fare) ?? null : null;
  return {
    route: { from, to, level, city_from: latest.airport_1 === to ? latest.city_2 : latest.city_1, city_to: latest.airport_1 === to ? latest.city_1 : latest.city_2, miles: latest.miles },
    latest: { period: latest.period, avg_fare_each_way: latest.avg_fare, passengers_per_day: latest.passengers_per_day, largest_carrier: lg, lowest_fare_carrier: lo },
    year_over_year: ly ? { prior_period: ly.period, prior_avg_fare: ly.avg_fare, change_pct: pctOf(latest.avg_fare, ly.avg_fare) } : null,
    lower_fare_carrier: lowFare, seasonality,
    nearby_airports: nearby.length > 1 ? { period: latest.period, options: nearby, cheapest_alternative: cheaper } : null,
    history: h.slice(0, 12).map(x => ({ period: x.period, avg_fare: x.avg_fare, passengers_per_day: x.passengers_per_day, largest_carrier: x.largest_carrier?.code ?? null })),
  };
}

const code = (v: unknown) => { const s = String(v ?? "").trim().toUpperCase(); return /^[A-Z]{3}$/.test(s) ? s : null; };
const pairWhere = (a: string, b: string) => `(airport_1='${a}' AND airport_2='${b}') OR (airport_1='${b}' AND airport_2='${a}')`;
const cmWhere = (a: string, b: string) => `(citymarketid_1='${a}' AND citymarketid_2='${b}') OR (citymarketid_1='${b}' AND citymarketid_2='${a}')`;

async function cityMarketOf(ap: string): Promise<string | null> {
  const r = await soql(T1A, `airport_1='${ap}' OR airport_2='${ap}'`, 1);
  if (!r.length) return null;
  return r[0].airport_1 === ap ? r[0].citymarketid_1 : r[0].citymarketid_2;
}

export async function airfareBenchmark(q: any = {}) {
  const from = code(q.from ?? q.origin), to = code(q.to ?? q.destination);
  if (!from || !to || from === to) throw Object.assign(new Error("from and to must be two different 3-letter US airport codes (IATA), e.g. from=MIA&to=JFK"), { status: 400 });
  let level: "airport_pair" | "city_pair" = "airport_pair";
  let hist = (await soql(T1A, pairWhere(from, to))).map(normFare);
  let cm1 = hist[0]?.citymarket_1 ?? null, cm2 = hist[0]?.citymarket_2 ?? null;
  if (!hist.length) {
    [cm1, cm2] = await Promise.all([cityMarketOf(from), cityMarketOf(to)]);
    if (cm1 && cm2 && cm1 !== cm2) { hist = (await soql(T6, cmWhere(cm1, cm2))).map(normFare); level = "city_pair"; }
  }
  if (!hist.length) throw Object.assign(new Error(`no DOT fare data for ${from}–${to}: the report covers U.S. domestic markets in the 48 contiguous states with at least ~10 passengers/day`), { status: 404 });
  const latest = [...hist].sort((a, b) => b.year - a.year || b.quarter - a.quarter)[0];
  const [alts, metro] = cm1 && cm2 ? await Promise.all([
    soql(T1A, `(${cmWhere(cm1, cm2)}) AND year='${latest.year}' AND quarter='${latest.quarter}'`, 50, "fare ASC").then(r => r.map(normFare)).catch(() => []),
    soql(T6, `(${cmWhere(cm1, cm2)}) AND year='${latest.year}' AND quarter='${latest.quarter}'`, 1).then(r => r.map(normFare)[0] ?? null).catch(() => null),
  ]) : [[], null];
  const s = airfareSummary(hist, alts, from, to, level);
  return {
    ...s, metro_market: metro ? { cities: `${metro.city_1} – ${metro.city_2}`, avg_fare_all_airports: metro.avg_fare, passengers_per_day: metro.passengers_per_day } : null,
    data_lag: `Latest DOT quarter is ${latest.period}; the report is published ~5–6 months after the quarter ends.`,
    how_to_use: "These are average fares actually paid (each way, incl. taxes, all cabins), not today's price. Use them as the benchmark: a live quote well under the average is a good fare; check the cheaper nearby airport pair and the lower-fare carrier before booking.",
    sources: ["U.S. DOT Domestic Airline Consumer Airfare Report — Table 1a (airport pairs) and Table 6 (city pairs), data.transportation.gov (public domain)"],
    as_of: new Date().toISOString(), disclaimer: "Information and analytics only — not a fare quote or travel advice.",
  };
}
