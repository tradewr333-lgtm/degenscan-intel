/**
 * Carry analytics (HI Carry architect's report 26/10, §2–3): statistics computed from OUR hourly funding history
 * (every perp on every Hyperliquid dex, kept beyond the 500 h the API returns) — things the exchange does not give anyone.
 *  - regime      (D3)  floor / premium / negative / zero share of hours per market
 *  - calendar    (D4)  funding by UTC weekday, weekday-vs-weekend, which dexes collapse on weekends
 *  - oracleHealth(D5)  frozen funding, stale marks, HIP-3 legs diverging from their peers
 *  - extremes    (D7/8) funding extremes with realized 24h/7d/14d next to the instant rate + time in extreme
 *  - aftermath   (D8)  past extreme episodes: price return and funding accrued 4/12/24 h later, half-life
 *  - breakeven   (D9)  round-trip cost and break-even for a funding spread by execution mode (slippage ASSUMED, labelled)
 *  - depth       (D15) hourly order-book depth at 5/10/20/50 bps — Hyperliquid keeps no book history
 * Descriptive statistics only: no signal, no recommendation, nothing personalised.
 */
import { getDb } from "../store/db.js";
import { ensureCarryTables, splitCoin, info, HOUR, APR, spotBase } from "./hl.js";

const FLOOR_1H = 0.0000125;                       // 0.01 %/8 h = 10.95 % a.a. — Hyperliquid's default interest floor
const r4 = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000;
const r2 = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;
const latest = () => (getDb().prepare("SELECT MAX(ts) AS t FROM hl_funding WHERE src = 'snapshot'").get() as any)?.t as number | null;
export const ANALYTICS_NOTE = "Descriptive statistics from Degenscan's hourly Hyperliquid history. Not a signal, not investment advice.";
const normCoin = (raw: string) => { const s = decodeURIComponent(String(raw ?? "")).trim(); const i = s.indexOf(":"); return i > 0 ? `${s.slice(0, i).toLowerCase()}:${s.slice(i + 1).toUpperCase()}` : s.toUpperCase(); };

/* ---------------- D3 regime ---------------- */
export function regime(opts: { coin?: string; days?: number; minVol?: number; limit?: number } = {}) {
  ensureCarryTables(); const t = latest(); if (!t) return { as_of: null, items: [] };
  const days = Math.min(Math.max(Number(opts.days) || 14, 1), 90); const since = t - days * 24 * HOUR;
  const coinQ = opts.coin ? normCoin(opts.coin) : null;
  const rows = getDb().prepare(`SELECT f.coin, f.dex, COUNT(*) AS n,
      SUM(CASE WHEN f.funding = 0 THEN 1 ELSE 0 END) AS zero, SUM(CASE WHEN f.funding < 0 THEN 1 ELSE 0 END) AS neg,
      SUM(CASE WHEN ABS(f.funding - ${FLOOR_1H}) < 0.0000000005 THEN 1 ELSE 0 END) AS floor, SUM(CASE WHEN f.funding > ${FLOOR_1H} + 0.0000000005 THEN 1 ELSE 0 END) AS prem,
      AVG(f.funding) AS avg, (SELECT vol24 FROM hl_funding WHERE coin = f.coin AND ts = ? AND src = 'snapshot') AS vol, (SELECT funding FROM hl_funding WHERE coin = f.coin AND ts = ?) AS now
    FROM hl_funding f WHERE f.ts > ? AND f.ts <= ? ${coinQ ? "AND f.coin = ?" : ""} GROUP BY f.coin`).all(...[t, t, since, t, ...(coinQ ? [coinQ] : [])]) as any[];
  const items = rows.filter(r => r.vol != null && (r.vol ?? 0) >= (opts.minVol ?? 0)).map(r => {
    const pct = (x: number) => r2(x / r.n * 100);
    const shares = { floor: pct(r.floor), premium: pct(r.prem), negative: pct(r.neg), zero: pct(r.zero), between_zero_and_floor: pct(r.n - r.floor - r.prem - r.neg - r.zero) };
    const dominant = (Object.entries(shares) as [string, number][]).sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))[0][0];
    const nowR = r.now == null ? null : r.now === 0 ? "zero" : r.now < 0 ? "negative" : Math.abs(r.now - FLOOR_1H) < 5e-10 ? "floor" : r.now > FLOOR_1H ? "premium" : "between_zero_and_floor";
    return { coin: r.coin, dex: r.dex, hours: r.n, regime_now: nowR, dominant_regime: dominant, pct_hours: shares, funding_apr_avg: r4(APR(r.avg)), vol24_usd: r.vol == null ? null : Math.round(r.vol) };
  }).sort((a, b) => (b.pct_hours.premium ?? 0) - (a.pct_hours.premium ?? 0));
  if (coinQ && !items.length) return null;
  const byDex: Record<string, { markets: number; at_floor_mostly: number; premium_mostly: number; negative_mostly: number }> = {};
  for (const i of items) { const d = byDex[i.dex] ??= { markets: 0, at_floor_mostly: 0, premium_mostly: 0, negative_mostly: 0 }; d.markets++; if (i.dominant_regime === "floor") d.at_floor_mostly++; if (i.dominant_regime === "premium") d.premium_mostly++; if (i.dominant_regime === "negative") d.negative_mostly++; }
  return { as_of: new Date(t).toISOString(), days, floor_apr: r4(APR(FLOOR_1H)), by_dex: byDex, count: items.length, items: items.slice(0, Math.min(Number(opts.limit) || 100, 500)), note: ANALYTICS_NOTE };
}

/* ---------------- D4 calendar ---------------- */
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function calendar(opts: { dex?: string; coin?: string; days?: number } = {}) {
  ensureCarryTables(); const t = latest(); if (!t) return { as_of: null, items: [] };
  const days = Math.min(Math.max(Number(opts.days) || 28, 7), 120); const since = t - days * 24 * HOUR;
  const coinQ = opts.coin ? normCoin(opts.coin) : null;
  const key = coinQ ? "coin" : "dex";
  const rows = getDb().prepare(`SELECT ${key} AS k, CAST(strftime('%w', ts / 1000, 'unixepoch') AS INTEGER) AS dow, AVG(funding) AS a, COUNT(*) AS n
    FROM hl_funding WHERE ts > ? AND ts <= ? ${coinQ ? "AND coin = ?" : opts.dex ? "AND dex = ?" : ""} GROUP BY k, dow`).all(...[since, t, ...(coinQ ? [coinQ] : opts.dex ? [String(opts.dex)] : [])]) as any[];
  const by = new Map<string, any[]>(); for (const r of rows) (by.get(r.k) ?? by.set(r.k, []).get(r.k)!).push(r);
  const items = [...by.entries()].map(([k, rs]) => {
    const dowApr = Object.fromEntries(DOW.map((d, i) => { const x = rs.find(r => r.dow === i); return [d, x ? r4(APR(x.a)) : null]; }));
    const avgOf = (sel: any[]) => { const n = sel.reduce((s, r) => s + r.n, 0); return n ? sel.reduce((s, r) => s + r.a * r.n, 0) / n : null; };
    const wk = avgOf(rs.filter(r => r.dow >= 1 && r.dow <= 5)), we = avgOf(rs.filter(r => r.dow === 0 || r.dow === 6));
    const ratio = wk && we != null && wk > 0 ? we / wk : null;
    return { [key]: k, hours: rs.reduce((s, r) => s + r.n, 0), funding_apr_by_utc_weekday: dowApr, weekday_apr: r4(wk == null ? null : APR(wk)), weekend_apr: r4(we == null ? null : APR(we)),
      weekend_to_weekday_ratio: r2(ratio), collapses_on_weekend: ratio != null && wk != null && APR(wk) > 0.05 ? ratio < 0.3 : null };
  }).sort((a: any, b: any) => (b.weekday_apr ?? 0) - (a.weekday_apr ?? 0));
  if (coinQ && !items.length) return null;
  return { as_of: new Date(t).toISOString(), days, group_by: key, items, note: `Weekend = Saturday and Sunday UTC. HIP-3 equity dexes follow underlyings whose markets close on weekends. ${ANALYTICS_NOTE}` };
}

/* ---------------- D5 oracle health ---------------- */
export function oracleHealth(opts: { hours?: number; dex?: string } = {}) {
  ensureCarryTables(); const t = latest(); if (!t) return { as_of: null, flags: [] };
  const hours = Math.min(Math.max(Number(opts.hours) || 72, 12), 24 * 30); const since = t - hours * HOUR;
  const rows = getDb().prepare(`SELECT coin, dex, ts, funding, mark, oracle FROM hl_funding WHERE src = 'snapshot' AND ts > ? AND ts <= ? ${opts.dex ? "AND dex = ?" : ""} ORDER BY coin, ts`).all(...[since, t, ...(opts.dex ? [String(opts.dex)] : [])]) as any[];
  const flags: any[] = []; const frozenByDex: Record<string, number> = {};
  const marksNow = new Map<string, { dex: string; mark: number }>();
  let i = 0;
  while (i < rows.length) {
    let j = i; while (j < rows.length && rows[j].coin === rows[i].coin) j++;
    const s = rows.slice(i, j); const coin = s[0].coin, dex = s[0].dex;
    // runs of exactly-zero funding and of an unchanged oracle price
    const run = (pred: (a: any, b?: any) => boolean) => { let best = { len: 0, start: 0, end: 0 }, cur = 0, st = 0;
      for (let k = 0; k < s.length; k++) { if (pred(s[k], s[k - 1])) { if (cur === 0) st = s[k].ts; cur++; if (cur > best.len) best = { len: cur, start: st, end: s[k].ts }; } else cur = 0; }
      return { ...best, current: cur }; };
    const z = run(a => a.funding === 0);
    const st = run((a, b) => b != null && a.oracle != null && a.oracle === b.oracle);
    frozenByDex[dex] = (frozenByDex[dex] ?? 0) + s.filter(x => x.funding === 0).length;
    if (z.len >= 4) flags.push({ coin, dex, flag: "frozen_funding", longest_run_h: z.len, since: new Date(z.start).toISOString(), until: new Date(z.end).toISOString(), ongoing: z.current >= 4, weekend_hours: s.filter(x => x.funding === 0 && [0, 6].includes(new Date(x.ts).getUTCDay())).length });
    if (st.len >= 4) flags.push({ coin, dex, flag: "stale_oracle", longest_run_h: st.len + 1, since: new Date(st.start - HOUR).toISOString(), until: new Date(st.end).toISOString(), ongoing: st.current >= 4 });
    const last = s[s.length - 1]; if (last.ts === t && last.mark) marksNow.set(coin, { dex, mark: last.mark });
    i = j;
  }
  // HIP-3 legs of the same underlying: current mark ratio vs the 14-day spread of that ratio
  const groups = new Map<string, string[]>(); for (const [coin, v] of marksNow) { if (v.dex === "main") continue; const b = splitCoin(coin).base.toUpperCase(); (groups.get(b) ?? groups.set(b, []).get(b)!).push(coin); }
  const hist = getDb().prepare("SELECT ts, mark FROM hl_funding WHERE coin = ? AND src = 'snapshot' AND ts > ? AND mark IS NOT NULL");
  for (const [base, legs] of groups) for (let a = 0; a < legs.length; a++) for (let b = a + 1; b < legs.length; b++) {
    const A = new Map((hist.all(legs[a], t - 14 * 24 * HOUR) as any[]).map(r => [r.ts, r.mark])), B = hist.all(legs[b], t - 14 * 24 * HOUR) as any[];
    const lr = B.filter(r => A.has(r.ts)).map(r => Math.log(A.get(r.ts) / r.mark)); if (lr.length < 24) continue;
    const mu = lr.reduce((x, y) => x + y, 0) / lr.length, sd = Math.sqrt(lr.reduce((x, y) => x + (y - mu) ** 2, 0) / lr.length);
    const now = Math.log(marksNow.get(legs[a])!.mark / marksNow.get(legs[b])!.mark);
    if (sd > 0 && Math.abs(now - mu) > 2 * sd && Math.abs(now) > 0.002) flags.push({ coin: legs[a], peer: legs[b], base, flag: "divergent_vs_peer", basis_now_pct: r2(now * 100), basis_mean_14d_pct: r2(mu * 100), basis_sd_14d_pct: r2(sd * 100), z: r2((now - mu) / sd) });
  }
  return { as_of: new Date(t).toISOString(), hours, flags: flags.sort((x, y) => (y.ongoing ? 1 : 0) - (x.ongoing ? 1 : 0) || (y.longest_run_h ?? 0) - (x.longest_run_h ?? 0)),
    zero_funding_hours_by_dex: frozenByDex, definitions: { frozen_funding: "funding exactly 0.0 for ≥ 4 consecutive hours", stale_oracle: "oracle price unchanged for ≥ 5 consecutive hourly snapshots", divergent_vs_peer: "HIP-3 leg's log basis vs a same-underlying peer more than 2 sd from its 14-day mean (and > 0.2 %)" }, note: ANALYTICS_NOTE };
}

/* ---------------- D7/D8 extremes + aftermath ---------------- */
export function extremes(opts: { minAbsApr?: number; minVol?: number; limit?: number } = {}) {
  ensureCarryTables(); const t = latest(); if (!t) return { as_of: null, items: [] };
  const thr = Number(opts.minAbsApr) > 0 ? Number(opts.minAbsApr) : 2; const thr1h = thr / 8760;
  const now = getDb().prepare("SELECT coin, dex, funding, oi, vol24 FROM hl_funding WHERE ts = ? AND src = 'snapshot' AND ABS(funding) >= ?").all(t, thr1h) as any[];
  const avg = getDb().prepare("SELECT AVG(funding) AS a, COUNT(*) AS n FROM hl_funding WHERE coin = ? AND ts > ? AND ts <= ?");
  const hist = getDb().prepare("SELECT funding FROM hl_funding WHERE coin = ? AND ts <= ? ORDER BY ts DESC LIMIT 336");
  const items = now.filter(r => (r.vol24 ?? 0) >= (opts.minVol ?? 0)).map(r => {
    const R = (h: number) => { const a = avg.get(r.coin, t - h * HOUR, t) as any; return a?.n ? r4(APR(a.a)) : null; };
    const h = hist.all(r.coin, t) as any[]; let inExtreme = 0; for (const x of h) { if (x.funding != null && Math.abs(x.funding) >= thr1h && Math.sign(x.funding) === Math.sign(r.funding)) inExtreme++; else break; }
    return { coin: r.coin, dex: r.dex, funding_apr_now: r4(APR(r.funding)), realized_apr_24h: R(24), realized_apr_7d: R(168), realized_apr_14d: R(336), hours_in_extreme: inExtreme, side_paying: r.funding > 0 ? "longs" : "shorts", oi_usd: r.oi == null ? null : Math.round(r.oi), vol24_usd: r.vol24 == null ? null : Math.round(r.vol24) };
  }).sort((a, b) => Math.abs(b.funding_apr_now ?? 0) - Math.abs(a.funding_apr_now ?? 0));
  return { as_of: new Date(t).toISOString(), threshold_apr: thr, count: items.length, items: items.slice(0, Math.min(Number(opts.limit) || 50, 300)),
    note: `Instant funding next to what was actually paid on average (realized). Raw data, not a contrarian signal. ${ANALYTICS_NOTE}` };
}

export function aftermath(opts: { minAbsApr?: number; days?: number; coin?: string; limit?: number } = {}) {
  ensureCarryTables(); const t = latest(); if (!t) return { as_of: null, episodes: [] };
  const thr = Number(opts.minAbsApr) > 0 ? Number(opts.minAbsApr) : 2; const thr1h = thr / 8760;
  const days = Math.min(Math.max(Number(opts.days) || 30, 3), 120); const since = t - days * 24 * HOUR;
  const coinQ = opts.coin ? normCoin(opts.coin) : null;
  const rows = getDb().prepare(`SELECT coin, dex, ts, funding, mark FROM hl_funding WHERE ts > ? ${coinQ ? "AND coin = ?" : `AND coin IN (SELECT DISTINCT coin FROM hl_funding WHERE ts > ? AND ABS(funding) >= ?)`} ORDER BY coin, ts`).all(...(coinQ ? [since, coinQ] : [since, since, thr1h])) as any[];
  const eps: any[] = []; let i = 0;
  while (i < rows.length) {
    let j = i; while (j < rows.length && rows[j].coin === rows[i].coin) j++;
    const s = rows.slice(i, j); const at = new Map(s.map(x => [x.ts, x]));
    for (let k = 0; k < s.length; k++) {
      const x = s[k]; if (x.funding == null || Math.abs(x.funding) < thr1h) continue;
      const prev = s[k - 1]; if (prev && prev.funding != null && Math.abs(prev.funding) >= thr1h && Math.sign(prev.funding) === Math.sign(x.funding)) continue;   // only the onset
      const sgn = Math.sign(x.funding); let dur = 0, ended = false, half: number | null = null;
      for (let q = k; q < s.length && s[q].ts - x.ts <= 14 * 24 * HOUR; q++) {
        const f = s[q].funding ?? 0;
        if (!ended) { if (Math.sign(f) === sgn && Math.abs(f) >= thr1h) dur++; else ended = true; }
        if (half == null && Math.abs(f) < Math.abs(x.funding) / 2) half = (s[q].ts - x.ts) / HOUR;
        if (ended && half != null) break;
      }
      const ret = (h: number) => { const y = at.get(x.ts + h * HOUR); return x.mark && y?.mark ? r2((y.mark / x.mark - 1) * 100) : null; };
      const acc = (h: number) => { let sum = 0, n = 0; for (let q = 0; q < h; q++) { const y = at.get(x.ts + q * HOUR); if (y?.funding != null) { sum += y.funding; n++; } } return n === h ? r4(sum * 100) : null; };
      eps.push({ coin: x.coin, dex: x.dex, onset: new Date(x.ts).toISOString(), funding_apr_at_onset: r4(APR(x.funding)), side_paying: x.funding > 0 ? "longs" : "shorts",
        hours_above_threshold: dur, half_life_h: half, price_return_pct: { h4: ret(4), h12: ret(12), h24: ret(24) }, funding_accrued_pct: { h4: acc(4), h12: acc(12), h24: acc(24) } });
    }
    i = j;
  }
  eps.sort((a, b) => b.onset.localeCompare(a.onset));
  const hl = eps.map(e => e.half_life_h).filter((x): x is number => x != null).sort((a, b) => a - b);
  return { as_of: new Date(t).toISOString(), threshold_apr: thr, days, episodes_count: eps.length, median_half_life_h: hl.length ? hl[Math.floor(hl.length / 2)] : null,
    episodes: eps.slice(0, Math.min(Number(opts.limit) || 50, 500)),
    note: `price_return uses hourly marks (recorded from 2026-10-02); funding_accrued is the sum of hourly rates in % of notional, positive = paid by longs. Past episodes describe the past only. ${ANALYTICS_NOTE}` };
}

/* ---------------- D9 break-even ---------------- */
export const FEES = { taker_pct: 0.045, maker_pct: 0.015 };
export function breakeven(q: { spread_apr?: unknown; lev?: unknown; mode?: unknown; slippage_taker_pct?: unknown; slippage_maker_pct?: unknown; hold_days?: unknown }) {
  const spread = Number(q.spread_apr); if (!Number.isFinite(spread)) throw Object.assign(new Error("spread_apr required (decimal, e.g. 0.35 for 35 %/yr)"), { status: 400 });
  const lev = Math.min(Math.max(Number(q.lev) || 2, 1), 50);
  const mode = ["taker", "maker1", "maker2"].includes(String(q.mode)) ? String(q.mode) : "taker";
  const sT = Number.isFinite(Number(q.slippage_taker_pct)) && q.slippage_taker_pct !== undefined ? Number(q.slippage_taker_pct) : 0.2;
  const sM = Number.isFinite(Number(q.slippage_maker_pct)) && q.slippage_maker_pct !== undefined ? Number(q.slippage_maker_pct) : 0.1;
  const taker = FEES.taker_pct + sT, maker = FEES.maker_pct + sM;
  // two legs, each opened and closed = 4 fills
  const rt = mode === "taker" ? 4 * taker : mode === "maker1" ? 2 * taker + 2 * maker : 4 * maker;
  const dailyPct = spread * 100 / 365;
  const holds = [7, 14, 30, 60, ...(Number(q.hold_days) > 0 ? [Math.min(Number(q.hold_days), 365)] : [])];
  const marginFactor = lev / 2;    // margin = 2 × notional / lev
  return { input: { spread_apr: spread, lev, mode, slippage_taker_pct: sT, slippage_maker_pct: sM, slippage_source: "assumed" },
    fees: FEES, round_trip_cost_pct_of_notional: r4(rt), breakeven_days: dailyPct > 0 ? r2(rt / dailyPct) : null,
    breakeven_apr_by_hold: Object.fromEntries(holds.map(h => [`${h}d`, r4(rt / h * 365 / 100)])),
    net_return_on_margin_by_hold_pct: Object.fromEntries(holds.map(h => [`${h}d`, r2((dailyPct * h - rt) * marginFactor)])),
    note: `Slippage is ASSUMED (defaults 0.2 % taker, 0.1 % maker per fill) until measured fills exist; pass your own. Funding spreads change hour to hour — this is arithmetic on a constant spread. ${ANALYTICS_NOTE}` };
}

/* ---------------- D15 depth history ---------------- */
let depthReady = false;
function ensureDepth() { if (depthReady) return; getDb().exec(`CREATE TABLE IF NOT EXISTS hl_depth (coin TEXT NOT NULL, ts INTEGER NOT NULL, mid REAL, spread_bps REAL,
  bid5 REAL, ask5 REAL, bid10 REAL, ask10 REAL, bid20 REAL, ask20 REAL, bid50 REAL, ask50 REAL, PRIMARY KEY (coin, ts))`); depthReady = true; }
export function depthFromBook(levels: any[][]) {
  const bids = (levels?.[0] ?? []).map((l: any) => ({ px: Number(l.px), sz: Number(l.sz) })), asks = (levels?.[1] ?? []).map((l: any) => ({ px: Number(l.px), sz: Number(l.sz) }));
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0].px + asks[0].px) / 2;
  const within = (side: { px: number; sz: number }[], bps: number, isBid: boolean) => side.filter(l => isBid ? l.px >= mid * (1 - bps / 1e4) : l.px <= mid * (1 + bps / 1e4)).reduce((s, l) => s + l.px * l.sz, 0);
  return { mid, spread_bps: (asks[0].px - bids[0].px) / mid * 1e4, ...Object.fromEntries([5, 10, 20, 50].flatMap(b => [[`bid${b}`, within(bids, b, true)], [`ask${b}`, within(asks, b, false)]])) } as any;
}
/** Hourly: depth of the N most traded perps (all dexes) + their spot markets are not included (perp book only). */
export async function collectDepth(n = Number(process.env.DEPTH_COINS ?? 40), gapMs = 400) {
  ensureCarryTables(); ensureDepth(); const t = latest(); if (!t) return 0;
  const coins = (getDb().prepare("SELECT coin FROM hl_funding WHERE ts = ? AND src = 'snapshot' ORDER BY vol24 DESC LIMIT ?").all(t, n) as any[]).map(r => r.coin);
  const ins = getDb().prepare("INSERT OR REPLACE INTO hl_depth (coin, ts, mid, spread_bps, bid5, ask5, bid10, ask10, bid20, ask20, bid50, ask50) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  const hour = Math.floor(Date.now() / HOUR) * HOUR; let ok = 0;
  for (const coin of coins) {
    try { const b = await info<any>({ type: "l2Book", coin }); const d = depthFromBook(b?.levels); if (d) { ins.run(coin, hour, d.mid, d.spread_bps, d.bid5, d.ask5, d.bid10, d.ask10, d.bid20, d.ask20, d.bid50, d.ask50); ok++; } } catch { /* skip */ }
    await new Promise(r => setTimeout(r, gapMs));
  }
  getDb().prepare("DELETE FROM hl_depth WHERE ts < ?").run(hour - 180 * 24 * HOUR);
  return ok;
}
export function depth(coinRaw: string, hoursRaw?: unknown) {
  ensureDepth(); const coin = normCoin(coinRaw); const hours = Math.min(Math.max(Number(hoursRaw) || 24, 1), 24 * 90);
  const rows = getDb().prepare("SELECT * FROM hl_depth WHERE coin = ? AND ts > ? ORDER BY ts").all(coin, Date.now() - hours * HOUR) as any[];
  if (!rows.length) return null;
  const u = (x: number | null) => x == null ? null : Math.round(x);
  const fmt = (r: any) => ({ at: new Date(r.ts).toISOString(), mid: r.mid, spread_bps: r2(r.spread_bps), depth_usd: Object.fromEntries([5, 10, 20, 50].map(b => [`${b}bps`, { bid: u(r[`bid${b}`]), ask: u(r[`ask${b}`]) }])) });
  const med = (k: string) => { const a = rows.map(r => Math.min(r[`bid${k}`], r[`ask${k}`])).sort((x, y) => x - y); return u(a[Math.floor(a.length / 2)]); };
  return { coin, ...splitCoin(coin), hours: rows.length, latest: fmt(rows[rows.length - 1]), median_min_side_depth_usd: { "5bps": med("5"), "10bps": med("10"), "20bps": med("20"), "50bps": med("50") },
    history: rows.map(fmt), note: `Perp order book, one snapshot per hour from Hyperliquid l2Book (which keeps no history). ${ANALYTICS_NOTE}` };
}
export { spotBase };
