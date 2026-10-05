/**
 * Carry Desk (Lote B of the seller's order 04/10, approved by Renato): eligibility, capacity, realized carry, after-hours premium,
 * webhook alerts. Built on our hourly funding store plus Hyperliquid candles (1h) and order books, both cached.
 * Thresholds default to the HI Carry construction order §1.3 and are overridable per query. Statistics on public market data —
 * never a trade call, never a promise of return. Methodology: /docs/carry#method.
 */
import { createHmac, randomBytes } from "node:crypto";
import { getDb } from "../store/db.js";
import { info, HOUR, APR, crossDex, spotPerp, naked, watchdog, splitCoin } from "./hl.js";
import { sessionOpen } from "../engine/sessions.js";
import { US_EQUITY_SESSION } from "../universe/static.js";
import { loadUniverse } from "../universe/index.js";

const r4 = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000;
const r2 = (x: number | null | undefined) => x == null || !Number.isFinite(x) ? null : Math.round(x * 100) / 100;

// ------------------------------------------------------------------ cached market data
const candleCache = new Map<string, { at: number; rows: { t: number; c: number }[] }>();
/** Hourly closes for the last `hours` (perp coin like "xyz:NBIS" or a spot pair like "@107" / "PURR/USDC"). Cached 30 min. */
export async function candles(coin: string, hours = 336): Promise<{ t: number; c: number }[]> {
  const k = `${coin}|${hours}`; const hit = candleCache.get(k);
  if (hit && Date.now() - hit.at < 30 * 60_000) return hit.rows;
  const end = Date.now(); const rows = await info<any[]>({ type: "candleSnapshot", req: { coin, interval: "1h", startTime: end - hours * HOUR, endTime: end } }).catch(() => []);
  const out = (rows ?? []).map(r => ({ t: Math.floor(Number(r.t) / HOUR) * HOUR, c: Number(r.c) })).filter(r => Number.isFinite(r.c) && r.c > 0);
  candleCache.set(k, { at: Date.now(), rows: out });
  return out;
}
const bookCache = new Map<string, { at: number; v: { mid: number; bid20: number; ask20: number } | null }>();
/** USD depth within 20 bps of mid on each side. Cached 5 min. */
export async function depth20(coin: string) {
  const hit = bookCache.get(coin); if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  let v: { mid: number; bid20: number; ask20: number } | null = null;
  try {
    const b = await info<any>({ type: "l2Book", coin });
    const [bids, asks] = b?.levels ?? [[], []];
    const bb = Number(bids?.[0]?.px), ba = Number(asks?.[0]?.px);
    if (bb > 0 && ba > 0) {
      const mid = (bb + ba) / 2, lo = mid * (1 - 0.002), hi = mid * (1 + 0.002);
      const sum = (lv: any[], ok: (p: number) => boolean) => lv.reduce((a, l) => { const p = Number(l.px); return ok(p) ? a + p * Number(l.sz) : a; }, 0);
      v = { mid, bid20: sum(bids, p => p >= lo), ask20: sum(asks, p => p <= hi) };
    }
  } catch { v = null; }
  bookCache.set(coin, { at: Date.now(), v });
  return v;
}

function corr(a: number[], b: number[]) {
  const n = Math.min(a.length, b.length); if (n < 24) return null;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n, mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}
/** Aligned hourly closes of two series → returns correlation, basis (log ratio ×100) stats. */
function pairStats(a: { t: number; c: number }[], b: { t: number; c: number }[]) {
  const mb = new Map(b.map(x => [x.t, x.c]));
  const al = a.filter(x => mb.has(x.t)).map(x => ({ t: x.t, a: x.c, b: mb.get(x.t)! }));
  if (al.length < 24) return { n: al.length, corr: null, basis_now: null, basis_sd: null, basis_range: null, basis: [] as { t: number; v: number }[] };
  const ra: number[] = [], rb: number[] = [];
  for (let i = 1; i < al.length; i++) { ra.push(Math.log(al[i].a / al[i - 1].a)); rb.push(Math.log(al[i].b / al[i - 1].b)); }
  const basis = al.map(x => ({ t: x.t, v: Math.log(x.a / x.b) * 100 }));
  const vs = basis.map(x => x.v); const m = vs.reduce((x, y) => x + y, 0) / vs.length;
  const sd = Math.sqrt(vs.reduce((x, y) => x + (y - m) ** 2, 0) / vs.length);
  return { n: al.length, corr: corr(ra, rb), basis_now: vs[vs.length - 1], basis_sd: sd, basis_range: Math.max(...vs) - Math.min(...vs), basis };
}

/** Hourly funding spread series between two perps (short − long), or a single perp (spot-perp), over the last `hours`. */
function spreadSeries(shortCoin: string, longCoin: string | null, hours: number, until = Date.now()) {
  const since = until - hours * HOUR;
  const q = getDb().prepare("SELECT ts, funding FROM hl_funding WHERE coin = ? AND ts > ? AND ts <= ? ORDER BY ts");
  const s = new Map((q.all(shortCoin, since, until) as any[]).map(r => [r.ts, r.funding]));
  if (!longCoin) return [...s.entries()].filter(([, f]) => f != null).map(([t, f]) => ({ t, v: f as number }));
  const l = new Map((q.all(longCoin, since, until) as any[]).map(r => [r.ts, r.funding]));
  return [...s.entries()].filter(([t, f]) => f != null && l.get(t) != null).map(([t, f]) => ({ t, v: (f as number) - (l.get(t) as number) }));
}

// ------------------------------------------------------------------ candidate pairs
export interface Leg { coin: string; dex: string; side: "short" | "long"; kind: "perp" | "spot"; vol24_usd: number | null; oi_usd: number | null; funding_apr: number | null }
export interface Pair { pair_key: string; kind: "xdex" | "spot_perp"; base: string; legs: Leg[] }
export function candidates(minVol = 100_000): Pair[] {
  const out: Pair[] = [];
  for (const x of crossDex({ minVol, limit: 200 }).items as any[]) {
    const hi = x.legs[0], lo = x.legs[x.legs.length - 1];
    out.push({ pair_key: `xdex:${hi.coin}|${lo.coin}`, kind: "xdex", base: x.base, legs: [
      { coin: hi.coin, dex: hi.dex, side: "short", kind: "perp", vol24_usd: hi.vol24_usd, oi_usd: hi.oi_usd, funding_apr: hi.funding_apr },
      { coin: lo.coin, dex: lo.dex, side: "long", kind: "perp", vol24_usd: lo.vol24_usd, oi_usd: lo.oi_usd, funding_apr: lo.funding_apr }] });
  }
  for (const p of spotPerp({ minVol, limit: 200 }).items as any[]) {
    if (!p.spot_pair) continue;
    // positive funding: short the perp, hold spot (spot cannot be shorted on Hyperliquid, so negative funding is not a carry pair)
    out.push({ pair_key: `spot_perp:${p.perp}|${p.spot_pair}`, kind: "spot_perp", base: p.base, legs: [
      { coin: p.perp, dex: "main", side: "short", kind: "perp", vol24_usd: p.perp_vol24_usd, oi_usd: p.oi_usd, funding_apr: p.funding_apr },
      { coin: p.spot_pair, dex: "spot", side: "long", kind: "spot", vol24_usd: p.spot_vol24_usd, oi_usd: null, funding_apr: 0 }] });
  }
  return out;
}

// ------------------------------------------------------------------ B1 eligibility
export interface Thresholds { entry_apr: number; min_share: number; min_corr: number; max_basis_range: number; min_liq: number; max_breakeven_days: number; fee_bps: number }
export const DEFAULTS: Thresholds = { entry_apr: 0.10, min_share: 0.65, min_corr: 0.90, max_basis_range: 4, min_liq: 1_000_000, max_breakeven_days: 7, fee_bps: 4.5 };

export async function evaluatePair(p: Pair, th: Thresholds) {
  const [s, l] = p.legs;
  const ser = spreadSeries(s.coin, p.kind === "xdex" ? l.coin : null, 336);
  const spread14 = ser.length ? APR(ser.reduce((a, x) => a + x.v, 0) / ser.length) : null;
  const share = ser.length ? ser.filter(x => x.v > 0).length / ser.length : null;
  const [cs, cl] = await Promise.all([candles(s.coin), candles(l.coin)]);
  const st = pairStats(cs, cl);
  const minLiq = Math.min(s.vol24_usd ?? 0, l.vol24_usd ?? 0);
  const fees = 4 * th.fee_bps / 10_000;                                     // four taker fills (enter + exit, two legs), fraction of notional
  const breakeven = spread14 && spread14 > 0 ? fees / (spread14 / 365) : null;
  const basisCharge = st.basis_sd != null ? 2 * (st.basis_sd / 100) * (365 / 30) : 0;   // 2σ adverse basis, amortised over a 30-day max hold
  const check = (value: number | null, threshold: number, pass: boolean | null) => ({ value: r4(value), threshold, pass: pass ?? false });
  const checks: Record<string, any> = {
    spread_apr_14d: check(spread14, th.entry_apr, spread14 != null && spread14 >= th.entry_apr),
    share_positive_14d: check(share, th.min_share, share != null && share >= th.min_share),
    min_liquidity_usd: check(minLiq, th.min_liq, minLiq >= th.min_liq),
    breakeven_days_taker: check(breakeven, th.max_breakeven_days, breakeven != null && breakeven <= th.max_breakeven_days),
    basis_range_pct: check(st.basis_range, th.max_basis_range, st.basis_range != null && st.basis_range <= th.max_basis_range),
  };
  if (p.kind === "xdex") checks.corr_1h_14d = check(st.corr, th.min_corr, st.corr != null && st.corr >= th.min_corr);
  const eligible = Object.values(checks).every((c: any) => c.pass);
  const score = spread14 != null && share != null ? (spread14 - basisCharge) * share * (p.kind === "spot_perp" ? 0.6 : 1) : null;
  return { pair_key: p.pair_key, kind: p.kind, base: p.base, legs: p.legs.map(x => ({ coin: x.coin, dex: x.dex, side: x.side, funding_apr_now: x.funding_apr, vol24h_usd: x.vol24_usd, oi_usd: x.oi_usd })),
    hours_14d: ser.length, candle_hours: st.n, spread_apr_14d: r4(spread14), share_positive_14d: r2(share), corr_1h_14d: r4(st.corr), basis_now_pct: r4(st.basis_now), basis_sd_14d_pct: r4(st.basis_sd),
    basis_range_14d_pct: r4(st.basis_range), breakeven_days_taker: r2(breakeven), checks, eligible, score: r4(score) };
}

function ensureDeskTables() {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS carry_eligibility (pair_key TEXT PRIMARY KEY, eligible INTEGER NOT NULL, since INTEGER NOT NULL, updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS carry_alerts (id TEXT PRIMARY KEY, key_id TEXT NOT NULL, type TEXT NOT NULL, filter TEXT, channel TEXT NOT NULL, target TEXT NOT NULL,
      secret TEXT NOT NULL, created_at TEXT NOT NULL, last_fired TEXT, fires INTEGER NOT NULL DEFAULT 0, last_status INTEGER);
    CREATE TABLE IF NOT EXISTS carry_alert_state (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
}

let eligCache: { at: number; key: string; v: any } | null = null;
export async function eligible(th: Partial<Thresholds> = {}, opts: { minVol?: number; onlyEligible?: boolean; record?: boolean } = {}) {
  ensureDeskTables();
  const T: Thresholds = { ...DEFAULTS, ...Object.fromEntries(Object.entries(th).filter(([, v]) => v != null && Number.isFinite(v as number))) } as Thresholds;
  const key = JSON.stringify([T, opts.minVol ?? 100_000]);
  if (!opts.record && eligCache && eligCache.key === key && Date.now() - eligCache.at < 10 * 60_000) return filterElig(eligCache.v, opts.onlyEligible);
  const rows: any[] = [];
  for (const p of candidates(opts.minVol ?? 100_000)) { try { rows.push(await evaluatePair(p, T)); } catch { /* skip pair */ } }
  rows.sort((a, b) => (b.eligible ? 1 : 0) - (a.eligible ? 1 : 0) || (b.score ?? -9) - (a.score ?? -9));
  rows.forEach((r, i) => { r.rank = i + 1; });
  const now = Date.now(); const d = getDb();
  const prev = new Map((d.prepare("SELECT pair_key, eligible, since FROM carry_eligibility").all() as any[]).map(r => [r.pair_key, r]));
  for (const r of rows) {
    const pv = prev.get(r.pair_key); const e = r.eligible ? 1 : 0;
    const since = pv && pv.eligible === e ? pv.since : now;
    if (opts.record || key === JSON.stringify([DEFAULTS, 100_000])) d.prepare("INSERT INTO carry_eligibility (pair_key, eligible, since, updated) VALUES (?,?,?,?) ON CONFLICT(pair_key) DO UPDATE SET eligible = excluded.eligible, since = excluded.since, updated = excluded.updated").run(r.pair_key, e, since, now);
    r.since = new Date(since).toISOString();
  }
  const v = { as_of: new Date(now).toISOString(), thresholds: T, count: rows.length, eligible_count: rows.filter(r => r.eligible).length, items: rows,
    method: "/docs/carry#method", note: "Eligibility filter on public market statistics — not an entry signal, not investment advice." };
  eligCache = { at: now, key, v };
  return filterElig(v, opts.onlyEligible);
}
const filterElig = (v: any, only?: boolean) => only ? { ...v, items: v.items.filter((r: any) => r.eligible) } : v;

// ------------------------------------------------------------------ B2 capacity
export const CAPACITY_RULE = { pct_volume: 0.01, pct_depth20: 0.25, pct_oi: 0.05 } as const;
export async function capacity(opts: { capital?: number; lev?: number; maxPairs?: number } = {}) {
  const el = await eligible({}, {});
  const lev = Math.min(10, Math.max(1, opts.lev ?? 3));
  const items: any[] = [];
  for (const r of el.items.slice(0, 40)) {
    const legs: any[] = [];
    for (const l of r.legs) {
      const d = await depth20(l.coin);
      const side = l.side === "short" ? d?.bid20 ?? null : d?.ask20 ?? null;   // short sells into bids, long buys asks
      const caps = [l.vol24h_usd != null ? CAPACITY_RULE.pct_volume * l.vol24h_usd : null, side != null ? CAPACITY_RULE.pct_depth20 * side : null, l.oi_usd != null ? CAPACITY_RULE.pct_oi * l.oi_usd : null].filter((x): x is number => x != null);
      legs.push({ coin: l.coin, side: l.side, vol24h_usd: l.vol24h_usd, oi_usd: l.oi_usd, depth_bps20_usd: side == null ? null : Math.round(side), cap_leg_usd: caps.length ? Math.round(Math.min(...caps)) : 0 });
    }
    const notional = Math.min(...legs.map(l => l.cap_leg_usd));
    const marginAt = (L: number) => Math.round(r.kind === "xdex" ? 2 * notional / L : notional + notional / L);
    items.push({ pair_key: r.pair_key, kind: r.kind, base: r.base, eligible: r.eligible, score: r.score, legs, cap_pair_notional_usd: notional, cap_pair_margin_usd: { "1x": marginAt(1), "2x": marginAt(2), "3x": marginAt(3), "5x": marginAt(5) } });
  }
  let allocation: any = null;
  if (opts.capital && opts.capital > 0) {
    const maxPairs = Math.max(1, Math.min(20, opts.maxPairs ?? 4));
    const pool = items.filter(i => i.eligible).slice(0, maxPairs);
    let left = opts.capital; const per = opts.capital / Math.max(1, pool.length); const alloc: any[] = [];
    for (const p of pool) { const capM = p.kind === "xdex" ? 2 * p.cap_pair_notional_usd / lev : p.cap_pair_notional_usd + p.cap_pair_notional_usd / lev; const m = Math.min(per, capM, left); left -= m; alloc.push({ pair_key: p.pair_key, margin_usd: Math.round(m), limited_by_liquidity: m < per }); }
    allocation = { capital_usd: opts.capital, lev, max_pairs: maxPairs, pairs: alloc, unallocated_by_liquidity_usd: Math.round(left), note: pool.length ? undefined : "no eligible pair right now" };
  }
  return { as_of: el.as_of, rule: CAPACITY_RULE, lev, count: items.length, items, allocation, note: "Capacity = min(1% of 24h volume, 25% of book depth within 20 bps on the side the leg hits, 5% of open interest) per leg. Platform rule; read-only." };
}

// ------------------------------------------------------------------ B3 realized carry (ex-post, net)
export async function realized(pairKey: string, opts: { feeBps?: number } = {}) {
  const ci = pairKey.indexOf(":"); const kind = pairKey.slice(0, ci); const [sCoin, lCoin] = pairKey.slice(ci + 1).split("|");
  if (!sCoin || !lCoin || (kind !== "xdex" && kind !== "spot_perp")) throw new Error("pair must look like xdex:xyz:NBIS|io:NBIS or spot_perp:PURR|PURR/USDC (see /v1/carry/eligible pair_key)");
  const fee = 4 * (opts.feeBps ?? DEFAULTS.fee_bps) / 10_000;
  const [cs, cl] = await Promise.all([candles(sCoin, 720), candles(lCoin, 720)]);
  const st = pairStats(cs, cl);
  const windows = [168, 336, 720].map(h => {
    const ser = spreadSeries(sCoin, kind === "xdex" ? lCoin : null, h);
    const funding = ser.reduce((a, x) => a + x.v, 0);                        // fraction of notional received by the pair
    const since = Date.now() - h * HOUR; const b = st.basis.filter(x => x.t > since);
    const drift = b.length > 1 ? (b[b.length - 1].v - b[0].v) / 100 : 0;    // short leg up vs long leg = loss
    const maxAdverse = b.length > 1 ? Math.max(0, ...b.map(x => (x.v - b[0].v) / 100)) : 0;
    const net = funding - fee - drift;
    const mFactor = kind === "xdex" ? 3 / 2 : 3 / 4;                         // return on margin at 3x: xdex N/(2N/3); spot-perp N/(N+N/3)
    return { hours: h, hours_with_data: ser.length, funding_received_pct: r4(funding * 100), fees_pct: r4(fee * 100), basis_drift_pct: r4(drift * 100), net_pct_notional: r4(net * 100), net_pct_margin_3x: r4(net * mFactor * 100), max_adverse_basis_pct: r4(maxAdverse * 100) };
  });
  return { pair_key: pairKey, kind, legs: [{ coin: sCoin, side: "short" }, { coin: lCoin, side: "long" }], fee_bps_per_fill: opts.feeBps ?? DEFAULTS.fee_bps, windows, method: "/docs/carry#method",
    note: "Past performance of a hypothetical delta-neutral pair, net of four taker fills and basis drift. Not a guarantee of future results; not investment advice." };
}
export async function realizedAll() {
  const el = await eligible({}, {});
  const out: any[] = [];
  for (const r of el.items.slice(0, 30)) { try { const x = await realized(r.pair_key); out.push({ pair_key: r.pair_key, base: r.base, kind: r.kind, eligible: r.eligible, ...Object.fromEntries(x.windows.map((w: any) => [`net_pct_notional_${w.hours}h`, w.net_pct_notional])) }); } catch { /* skip */ } }
  return { as_of: el.as_of, count: out.length, items: out, note: "Past performance, net of fees and basis drift — not a guarantee of future results." };
}

// ------------------------------------------------------------------ B4 after-hours premium (HIP-3 perps vs last US session close)
/** Most recent US regular-session close (NYSE calendar incl. holidays) before `at`. */
export function lastUsClose(at = new Date()): Date {
  const step = 5 * 60_000; let t = Math.floor(at.getTime() / step) * step;
  for (let i = 0; i < 6 * 288; i++) { if (!sessionOpen(US_EQUITY_SESSION, new Date(t)) && sessionOpen(US_EQUITY_SESSION, new Date(t - step))) return new Date(t); t -= step; }
  return new Date(t);
}
/** US-listed stocks/ETFs (the only assets for which "premium vs the last US close" means something). Universe equities/ETFs plus
 *  US names commonly listed on HIP-3 dexes that may sit outside the daily top-100. Crypto, indices, commodities are excluded. */
const EXTRA_US = ["NBIS", "SNDK", "CRWD", "AVGO", "NET", "RDDT", "IREN", "AAOI", "CBRS", "EWY", "EWZ", "EWJ", "DRAM", "MU", "AMD", "INTC", "ORCL", "PLTR", "COIN", "HOOD", "MSTR", "CRCL", "TSLA", "NVDA", "AAPL", "MSFT", "GOOGL", "AMZN", "META", "NFLX", "BABA", "SMCI", "ARM", "TSM", "UBER", "SHOP", "SPY", "QQQ", "IWM", "GLD", "SLV", "USO", "TLT", "XLE", "XLF", "SMH", "SOXL", "VST", "CEG", "OKLO", "RKLB", "IONQ", "QBTS", "RGTI", "ASTS", "HIMS", "SOFI", "GME", "AMC"];
let usSet: Set<string> | null = null;
export function isUsListed(base: string) {
  if (!usSet) { usSet = new Set(EXTRA_US); try { for (const a of loadUniverse().assets as any[]) if (a.class === "equity" || a.class === "etf") usSet.add(String(a.id).toUpperCase()); } catch { /* seed only */ } }
  return usSet.has(base.toUpperCase());
}
export async function afterhours(coin?: string) {
  const now = new Date(); const open = sessionOpen(US_EQUITY_SESSION, now);
  const close = lastUsClose(now); const closeHour = Math.floor(close.getTime() / HOUR) * HOUR;
  const d = getDb(); const t = (d.prepare("SELECT MAX(ts) AS t FROM hl_funding WHERE src = 'snapshot'").get() as any)?.t;
  if (!t) return { as_of: null, items: [] };
  const coins = coin ? [coin] : (d.prepare("SELECT coin FROM hl_funding WHERE ts = ? AND src = 'snapshot' AND dex != 'main' AND COALESCE(vol24, 0) >= 50000 ORDER BY vol24 DESC").all(t) as any[]).map(r => r.coin).filter((c: string) => isUsListed(splitCoin(c).base));
  const items: any[] = [];
  for (const c of coins.slice(0, coin ? 1 : 60)) {
    const cur = d.prepare("SELECT mark, oracle, funding, oi, vol24 FROM hl_funding WHERE coin = ? AND ts = ? AND src = 'snapshot'").get(c, t) as any;
    if (!cur?.mark) continue;
    // reference: Hyperliquid oracle at the snapshot taken at/just before the close (the oracle tracks the underlying during the session);
    // fallback: the 1h mark candle that closes at the session close
    const refRow = d.prepare("SELECT oracle, mark, ts FROM hl_funding WHERE coin = ? AND src = 'snapshot' AND ts <= ? AND ts >= ? ORDER BY ts DESC LIMIT 1").get(c, closeHour, closeHour - 2 * HOUR) as any;
    let ref: number | null = refRow?.oracle ?? null; let refSrc = "hl_oracle_at_session_close";
    if (!ref) { const cd = await candles(c, Math.ceil((Date.now() - closeHour) / HOUR) + 3); const k = cd.filter(x => x.t <= closeHour - HOUR).pop(); ref = k?.c ?? null; refSrc = "hl_mark_1h_candle_at_session_close"; }
    const series = open ? [] : (await candles(c, Math.ceil((Date.now() - closeHour) / HOUR) + 1)).filter(x => x.t >= closeHour).map(x => ({ at: new Date(x.t).toISOString(), premium_pct: ref ? r4((x.c / ref - 1) * 100) : null }));
    const fw = spreadSeries(c, null, Math.max(1, Math.ceil((Date.now() - closeHour) / HOUR)));
    items.push({ coin: c, dex: splitCoin(c).dex, session: open ? "open" : "closed", last_close_at: close.toISOString(), last_close_ref: ref, ref_source: refSrc, mark_now: cur.mark, oracle_now: cur.oracle,
      premium_pct: ref ? r4((cur.mark / ref - 1) * 100) : null, funding_apr_window: fw.length ? r4(APR(fw.reduce((a, x) => a + x.v, 0) / fw.length)) : null, oi_usd: cur.oi == null ? null : Math.round(cur.oi), vol24h_usd: cur.vol24 == null ? null : Math.round(cur.vol24), series });
  }
  items.sort((a, b) => Math.abs(b.premium_pct ?? 0) - Math.abs(a.premium_pct ?? 0));
  return { as_of: new Date(t).toISOString(), session: open ? "open" : "closed", last_close_at: close.toISOString(), count: items.length, items,
    coverage: "US-listed stocks and ETFs on HIP-3 dexes (crypto, indices and commodities trade around the clock and are excluded).",
    note: "Premium of HIP-3 perps vs the last US regular-session close (NYSE calendar). Reference = Hyperliquid oracle at the close (approximation of the official close). Statistics, never a direction." };
}

// ------------------------------------------------------------------ B5 alerts (webhook, HMAC-SHA256)
export const ALERT_TYPES = ["eligible_on", "eligible_off", "naked_extreme", "watchdog_flag", "afterhours_premium"] as const;
export function createAlert(keyId: string, body: any) {
  ensureDeskTables();
  const type = String(body?.type ?? ""); if (!(ALERT_TYPES as readonly string[]).includes(type)) throw new Error(`type must be one of ${ALERT_TYPES.join(", ")}`);
  const channel = String(body?.channel ?? "webhook"); if (channel !== "webhook") throw new Error("channel: webhook (Telegram comes later)");
  const target = String(body?.target ?? ""); if (!/^https:\/\/[^\s]{4,500}$/.test(target)) throw new Error("target must be an https:// URL");
  const n = (getDb().prepare("SELECT COUNT(*) AS n FROM carry_alerts WHERE key_id = ?").get(keyId) as any).n; if (n >= 50) throw new Error("max 50 alerts per key");
  const id = "al_" + randomBytes(6).toString("hex"); const secret = "whsec_" + randomBytes(18).toString("base64url");
  getDb().prepare("INSERT INTO carry_alerts (id, key_id, type, filter, channel, target, secret, created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, keyId, type, JSON.stringify(body?.filter ?? {}), channel, target, secret, new Date().toISOString());
  return { id, type, channel, target, filter: body?.filter ?? {}, secret, note: "Verify X-Carry-Signature = hex(HMAC-SHA256(secret, raw body)). The secret is shown once." };
}
export function listAlerts(keyId: string) { ensureDeskTables(); return (getDb().prepare("SELECT id, type, filter, channel, target, created_at, last_fired, fires, last_status FROM carry_alerts WHERE key_id = ? ORDER BY created_at").all(keyId) as any[]).map(r => ({ ...r, filter: JSON.parse(r.filter || "{}") })); }
export function deleteAlert(keyId: string, id: string) { ensureDeskTables(); return getDb().prepare("DELETE FROM carry_alerts WHERE key_id = ? AND id = ?").run(keyId, id).changes; }

async function post(a: any, payload: any) {
  const body = JSON.stringify(payload); const sig = createHmac("sha256", a.secret).update(body).digest("hex");
  let status = 0;
  try { const r = await fetch(a.target, { method: "POST", headers: { "content-type": "application/json", "x-carry-signature": sig, "user-agent": "degenscan-carry-alerts/1" }, body, signal: AbortSignal.timeout(5000) }); status = r.status; } catch { status = -1; }
  getDb().prepare("UPDATE carry_alerts SET last_fired = ?, fires = fires + 1, last_status = ? WHERE id = ?").run(new Date().toISOString(), status, a.id);
}
const stateGet = (k: string) => { const r = getDb().prepare("SELECT v FROM carry_alert_state WHERE k = ?").get(k) as any; return r ? JSON.parse(r.v) : null; };
const stateSet = (k: string, v: any) => getDb().prepare("INSERT INTO carry_alert_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, JSON.stringify(v));

/** Run after each hourly snapshot: refresh eligibility (recorded), diff against the previous run, fire matching webhooks. */
export async function hourlyDesk() {
  ensureDeskTables();
  const el = await eligible({}, { record: true });
  const nowElig = el.items.filter((r: any) => r.eligible).map((r: any) => r.pair_key);
  const prevElig: string[] = stateGet("eligible") ?? nowElig;
  const on = nowElig.filter((k: string) => !prevElig.includes(k)), off = prevElig.filter(k => !nowElig.includes(k));
  stateSet("eligible", nowElig);
  const nk = naked({}); const nkNow = nk.items.map((i: any) => i.coin); const nkPrev: string[] = stateGet("naked") ?? nkNow; stateSet("naked", nkNow);
  const newNaked = nk.items.filter((i: any) => !nkPrev.includes(i.coin));
  const wd = watchdog(); const flagsNow = wd.markets.filter((m: any) => m.risk_flags.length).map((m: any) => `${m.coin}:${m.risk_flags.join("+")}`); const flagsPrev: string[] = stateGet("flags") ?? flagsNow; stateSet("flags", flagsNow);
  const newFlags = wd.markets.filter((m: any) => m.risk_flags.length && !flagsPrev.includes(`${m.coin}:${m.risk_flags.join("+")}`));
  // public leaderboard headline (count only, never the coins): US equities on HIP-3 trading away from the last NYSE close
  try { const a = await afterhours(); const away = a.items.filter((i: any) => Math.abs(i.premium_pct ?? 0) >= 1); stateSet("ah_summary", { at: a.as_of, session: a.session, n: a.count, n_away_1pct: away.length, median_abs_pct: away.length ? r4([...away.map((i: any) => Math.abs(i.premium_pct))].sort((x, y) => x - y)[Math.floor(away.length / 2)]) : null }); } catch { /* optional */ }
  const alerts = getDb().prepare("SELECT a.* FROM carry_alerts a JOIN api_keys k ON k.id = a.key_id WHERE k.status = 'active' AND k.plan = 'carry_desk' AND (k.expires_at IS NULL OR k.expires_at > ?)").all(new Date().toISOString()) as any[];
  if (!alerts.length) return { alerts: 0 };
  let ah: any = null;
  const disclaimer = "Market data and analytics only — not a signal, not investment advice.";
  for (const a of alerts) {
    const f = JSON.parse(a.filter || "{}"); const match = (s: string) => !f.pair && !f.coin && !f.dex ? true : [f.pair, f.coin, f.dex].filter(Boolean).some((x: string) => s.includes(x));
    if (a.type === "eligible_on") for (const k of on.filter(match)) await post(a, { type: a.type, pair_key: k, at: el.as_of, detail: el.items.find((r: any) => r.pair_key === k), disclaimer });
    if (a.type === "eligible_off") for (const k of off.filter(match)) await post(a, { type: a.type, pair_key: k, at: el.as_of, disclaimer });
    if (a.type === "naked_extreme") for (const i of newNaked.filter((i: any) => match(i.coin) && Math.abs(i.funding_apr_now) >= (Number(f.min_abs_apr) || 0.5))) await post(a, { type: a.type, at: nk.as_of, item: i, disclaimer });
    if (a.type === "watchdog_flag") for (const m of newFlags.filter((m: any) => match(m.coin))) await post(a, { type: a.type, at: wd.as_of, market: m, disclaimer });
    if (a.type === "afterhours_premium") {
      ah = ah ?? await afterhours();
      const thr = Number(f.min_abs_premium_pct) || 3;
      for (const i of ah.items.filter((i: any) => match(i.coin) && Math.abs(i.premium_pct ?? 0) >= thr)) {
        const k = `ah:${a.id}:${i.coin}:${i.last_close_at}`; if (stateGet(k)) continue; stateSet(k, 1);
        await post(a, { type: a.type, at: ah.as_of, item: { ...i, series: undefined }, disclaimer });
      }
    }
  }
  return { alerts: alerts.length, eligible_on: on.length, eligible_off: off.length };
}

/** Aggregates for the public leaderboard: counts only. */
export function publicDeskSummary() {
  try { ensureDeskTables(); const d = getDb();
    const elig = (d.prepare("SELECT COUNT(*) AS n FROM carry_eligibility WHERE eligible = 1").get() as any)?.n ?? 0;
    return { eligible: elig, afterhours: stateGet("ah_summary") };
  } catch { return { eligible: 0, afterhours: null }; }
}
