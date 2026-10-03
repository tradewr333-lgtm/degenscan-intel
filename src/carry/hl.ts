/**
 * Carry Oracle — data layer (Renato 04/10, HI Carry architect report §8): persist, without a window, the hourly funding of EVERY
 * Hyperliquid perp on EVERY dex (main + HIP-3: xyz, flx, vntl, hyna, km, abcd, cash, para, mkts, io …) plus spot marks.
 * Hyperliquid's API only returns the last 500 h of funding; whatever is not stored is lost for good. This module:
 *   1. snapshots metaAndAssetCtxs for all dexes + spotMetaAndAssetCtxs every hour (at :03),
 *   2. once per coin, backfills fundingHistory for the last 500 h (rate-limited, background, never blocks the loop),
 *   3. serves read-only views: funding matrix, cross-dex spreads, per-coin history, dataset stats.
 * Data and analytics only — not a signal, not investment advice.
 */
import { getDb } from "../store/db.js";
import { UA } from "../ingest/http.js";

const HL_INFO = process.env.HYPERLIQUID_INFO_URL ?? "https://api.hyperliquid.xyz/info";
const HOUR = 3_600_000;
export const APR = (hourly: number) => hourly * 24 * 365;

async function info<T = any>(body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
  const r = await fetch(HL_INFO, { method: "POST", headers: { "content-type": "application/json", "user-agent": UA }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`HL ${r.status} ${JSON.stringify(body).slice(0, 60)}`);
  return r.json() as Promise<T>;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const yieldLoop = () => new Promise(r => setImmediate(r));

let ready = false;
export function ensureCarryTables() {
  if (ready) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS hl_funding (
      coin TEXT NOT NULL, dex TEXT NOT NULL, ts INTEGER NOT NULL,
      funding REAL, premium REAL, mark REAL, oracle REAL, oi REAL, vol24 REAL, src TEXT NOT NULL,
      PRIMARY KEY (coin, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_hlf_ts ON hl_funding(ts);
    CREATE INDEX IF NOT EXISTS idx_hlf_dex_ts ON hl_funding(dex, ts);
    CREATE TABLE IF NOT EXISTS hl_spot (
      pair TEXT NOT NULL, base TEXT NOT NULL, ts INTEGER NOT NULL, mark REAL, vol24 REAL,
      PRIMARY KEY (pair, ts)
    );
    CREATE INDEX IF NOT EXISTS idx_hls_base_ts ON hl_spot(base, ts);
    CREATE TABLE IF NOT EXISTS hl_backfill (coin TEXT PRIMARY KEY, done_at TEXT NOT NULL, rows INTEGER NOT NULL);
  `);
  ready = true;
}

const num = (x: unknown) => { const n = Number(x); return Number.isFinite(n) ? n : null; };
/** "xyz:NBIS" → { dex: "xyz", base: "NBIS" }; "BTC" → { dex: "main", base: "BTC" } */
export function splitCoin(coin: string) { const i = coin.indexOf(":"); return i > 0 ? { dex: coin.slice(0, i), base: coin.slice(i + 1) } : { dex: "main", base: coin }; }

let lastSnapshot: { at: string; perps: number; spot: number; dexes: string[]; error?: string } | null = null;
let backfill = { running: false, done: 0, todo: 0, rows: 0, errors: 0, started_at: null as string | null };

/** One hourly snapshot of all perp dexes and spot. Returns the list of active coins. */
export async function snapshot(now = Date.now()): Promise<string[]> {
  ensureCarryTables();
  const ts = Math.floor(now / HOUR) * HOUR;
  const dexes: (string | null)[] = ((await info<any[]>({ type: "perpDexs" })) ?? []).map(d => (d && d.name) || null);
  const ins = getDb().prepare("INSERT OR REPLACE INTO hl_funding (coin, dex, ts, funding, premium, mark, oracle, oi, vol24, src) VALUES (?,?,?,?,?,?,?,?,?, 'snapshot')");
  const coins: string[] = []; let perps = 0;
  for (const dex of dexes) {
    const m = await info<any[]>(dex ? { type: "metaAndAssetCtxs", dex } : { type: "metaAndAssetCtxs" });
    const uni: any[] = m?.[0]?.universe ?? [], ctx: any[] = m?.[1] ?? [];
    const db = getDb(); db.exec("BEGIN");
    try {
      uni.forEach((u, i) => {
        if (u?.isDelisted) return;
        const c = ctx[i] ?? {}; const mark = num(c.markPx);
        ins.run(String(u.name), dex ?? "main", ts, num(c.funding), num(c.premium), mark, num(c.oraclePx), mark != null && num(c.openInterest) != null ? mark * Number(c.openInterest) : null, num(c.dayNtlVlm));
        coins.push(String(u.name)); perps++;
      });
      db.exec("COMMIT");
    } catch (e) { db.exec("ROLLBACK"); throw e; }
    await yieldLoop();
  }
  // spot: pair → base token name (PURR/USDC → PURR; "@107" → tokens[base].name)
  let spot = 0;
  try {
    const s = await info<any[]>({ type: "spotMetaAndAssetCtxs" });
    const tokens: any[] = s?.[0]?.tokens ?? []; const tok = new Map(tokens.map(t => [t.index, t.name]));
    const pairs = new Map((s?.[0]?.universe ?? []).map((u: any) => [u.name, tok.get(u.tokens?.[0]) ?? String(u.name).split("/")[0]]));
    const insS = getDb().prepare("INSERT OR REPLACE INTO hl_spot (pair, base, ts, mark, vol24) VALUES (?,?,?,?,?)");
    const db = getDb(); db.exec("BEGIN");
    try { for (const c of (s?.[1] ?? []) as any[]) { const pair = String(c.coin); insS.run(pair, String(pairs.get(pair) ?? pair), ts, num(c.markPx), num(c.dayNtlVlm)); spot++; } db.exec("COMMIT"); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  } catch (e) { console.warn("[carry] spot snapshot:", (e as Error).message); }
  lastSnapshot = { at: new Date(ts).toISOString(), perps, spot, dexes: dexes.map(d => d ?? "main") };
  return coins;
}

/** Backfill the last 500 h of funding for coins never backfilled. ~1 request/1.2 s (HL weight 20/req, 1200/min budget). */
export async function backfillMissing(coins: string[], gapMs = Number(process.env.CARRY_BACKFILL_GAP_MS ?? 1200)) {
  if (backfill.running) return;
  ensureCarryTables();
  const doneSet = new Set((getDb().prepare("SELECT coin FROM hl_backfill").all() as any[]).map(r => r.coin));
  const todo = coins.filter(c => !doneSet.has(c));
  if (!todo.length) return;
  backfill = { running: true, done: 0, todo: todo.length, rows: 0, errors: 0, started_at: new Date().toISOString() };
  console.log(`[carry] backfilling 500h funding history for ${todo.length} coins`);
  const ins = getDb().prepare("INSERT OR IGNORE INTO hl_funding (coin, dex, ts, funding, premium, src) VALUES (?,?,?,?,?, 'history')");
  const mark = getDb().prepare("INSERT OR REPLACE INTO hl_backfill (coin, done_at, rows) VALUES (?,?,?)");
  for (const coin of todo) {
    try {
      const rows = await info<any[]>({ type: "fundingHistory", coin, startTime: Date.now() - 500 * HOUR });
      const { dex } = splitCoin(coin); let n = 0;
      const db = getDb(); db.exec("BEGIN");
      try { for (const r of rows ?? []) { const t = Math.floor(Number(r.time) / HOUR) * HOUR; if (ins.run(coin, dex, t, num(r.fundingRate), num(r.premium)).changes) n++; } db.exec("COMMIT"); }
      catch (e) { db.exec("ROLLBACK"); throw e; }
      mark.run(coin, new Date().toISOString(), n); backfill.rows += n;
    } catch (e) { backfill.errors++; if (backfill.errors <= 3) console.warn(`[carry] backfill ${coin}: ${(e as Error).message}`); await sleep(5_000); }
    backfill.done++;
    await sleep(gapMs);
  }
  backfill.running = false;
  console.log(`[carry] backfill done: ${backfill.done} coins, +${backfill.rows} rows, ${backfill.errors} errors`);
}

/** Hourly scheduler: snapshot at :03 every hour; first run 60 s after boot, then backfill whatever is missing. */
export function startCarryCollector() {
  if (process.env.CARRY_COLLECTOR === "0") return;
  ensureCarryTables();
  let lastHour = -1;
  const run = async () => {
    try { const coins = await snapshot(); backfillMissing(coins).catch(e => console.warn("[carry] backfill:", (e as Error).message)); }
    catch (e) { lastSnapshot = { ...(lastSnapshot ?? { perps: 0, spot: 0, dexes: [] }), at: lastSnapshot?.at ?? "", error: (e as Error).message }; console.warn("[carry] snapshot:", (e as Error).message); }
  };
  setTimeout(() => { lastHour = Math.floor(Date.now() / HOUR); run(); }, 60_000);
  setInterval(() => { const d = new Date(); const h = Math.floor(d.getTime() / HOUR); if (h !== lastHour && d.getUTCMinutes() >= 3) { lastHour = h; run(); } }, 30_000).unref();
  console.log("[carry] Hyperliquid funding collector: hourly at :03 (all perp dexes + spot), 500h backfill per new coin");
}

// ------------------------------------------------------------------ read views
export function carryStats() {
  ensureCarryTables();
  const d = getDb();
  const f = d.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT coin) AS coins, COUNT(DISTINCT dex) AS dexes, MIN(ts) AS first, MAX(ts) AS last FROM hl_funding").get() as any;
  const s = d.prepare("SELECT COUNT(*) AS rows, COUNT(DISTINCT pair) AS pairs FROM hl_spot").get() as any;
  const snaps = (d.prepare("SELECT COUNT(DISTINCT ts) AS n FROM hl_funding WHERE src = 'snapshot'").get() as any).n;
  return {
    funding: { rows: f.rows, coins: f.coins, dexes: f.dexes, first_hour: f.first ? new Date(f.first).toISOString() : null, last_hour: f.last ? new Date(f.last).toISOString() : null, hourly_snapshots: snaps },
    spot: { rows: s.rows, pairs: s.pairs }, last_snapshot: lastSnapshot, backfill,
    note: "Hyperliquid's API keeps only 500 h of funding; this dataset keeps every hour from the first snapshot onward, for every dex.",
  };
}

const latestTs = () => (getDb().prepare("SELECT MAX(ts) AS t FROM hl_funding WHERE src = 'snapshot'").get() as any)?.t as number | null;

/** Hyperliquid spot wraps majors as U-tokens (UBTC, UETH, USOL…): map them to the perp ticker. */
const SPOT_ALIAS: Record<string, string> = { UBTC: "BTC", UETH: "ETH", USOL: "SOL", UFART: "FARTCOIN", UPUMP: "PUMP", UXPL: "XPL", UENA: "ENA", UDOGE: "DOGE", UXRP: "XRP", USUI: "SUI", UBONK: "BONK", ULINK: "LINK", UAVAX: "AVAX", UADA: "ADA", ULTC: "LTC" };
export const spotBase = (b: string) => { const u = b.toUpperCase(); return SPOT_ALIAS[u] ?? u; };

/** Latest funding for every perp on every dex, annualised, with the matching spot mark when one exists. */
export function fundingMatrix(opts: { dex?: string; minVol?: number; delayH?: number } = {}) {
  ensureCarryTables();
  const d = getDb(); let t = latestTs(); if (!t) return { as_of: null, items: [] };
  if (opts.delayH) t = (d.prepare("SELECT MAX(ts) AS t FROM hl_funding WHERE src='snapshot' AND ts <= ?").get(t - opts.delayH * HOUR) as any)?.t ?? t;
  const rows = d.prepare("SELECT coin, dex, funding, premium, mark, oracle, oi, vol24 FROM hl_funding WHERE ts = ? AND src = 'snapshot'" + (opts.dex ? " AND dex = ?" : "")).all(...(opts.dex ? [t, opts.dex] : [t])) as any[];
  const spot = new Map<string, any>();
  for (const r of d.prepare("SELECT base, mark, vol24 FROM hl_spot WHERE ts = ? ORDER BY vol24 ASC").all(t) as any[]) spot.set(spotBase(String(r.base)), r);   // most liquid pair wins
  const items = rows.filter(r => (r.vol24 ?? 0) >= (opts.minVol ?? 0)).map(r => {
    const { base } = splitCoin(r.coin); const sp = spot.get(base.toUpperCase());
    return { coin: r.coin, dex: r.dex, base, funding_1h: r.funding, funding_apr: r.funding == null ? null : Math.round(APR(r.funding) * 10000) / 10000, mark: r.mark, oi_usd: r.oi == null ? null : Math.round(r.oi), vol24_usd: r.vol24 == null ? null : Math.round(r.vol24), spot: sp ? { mark: sp.mark, vol24_usd: Math.round(sp.vol24 ?? 0) } : null };
  }).sort((a, b) => Math.abs(b.funding_apr ?? 0) - Math.abs(a.funding_apr ?? 0));
  return { as_of: new Date(t as number).toISOString(), count: items.length, items };
}

/** Same underlying listed on 2+ perp dexes: current and 14-day funding spread between the legs. Statistics, not a trade call. */
export function crossDex(opts: { minVol?: number; delayH?: number; limit?: number } = {}) {
  const m = fundingMatrix({ delayH: opts.delayH });
  if (!m.as_of) return { as_of: null, items: [] };
  const t = new Date(m.as_of).getTime(); const d = getDb();
  const avg = d.prepare("SELECT AVG(funding) AS a, SUM(CASE WHEN funding > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS pos, COUNT(*) AS n FROM hl_funding WHERE coin = ? AND ts > ? AND ts <= ?");
  const groups = new Map<string, any[]>();
  // HIP-3 dexes only: a main-dex ticker is a different asset from a same-named HIP-3 listing (STX = Stacks on main, a stock on para)
  for (const it of m.items) { if (it.dex === "main") continue; if ((it.vol24_usd ?? 0) < (opts.minVol ?? 100_000)) continue; const k = it.base.toUpperCase(); (groups.get(k) ?? groups.set(k, []).get(k)!).push(it); }
  const items: any[] = [];
  for (const [base, legs] of groups) {
    if (legs.length < 2) continue;
    const L = legs.map(l => { const a = avg.get(l.coin, t - 14 * 24 * HOUR, t) as any; return { coin: l.coin, dex: l.dex, funding_apr: l.funding_apr, funding_apr_14d: a?.a == null ? null : Math.round(APR(a.a) * 10000) / 10000, hours_positive_14d: a?.pos == null ? null : Math.round(a.pos * 100) / 100, hours_14d: a?.n ?? 0, vol24_usd: l.vol24_usd, oi_usd: l.oi_usd, mark: l.mark }; })
      .sort((a, b) => (b.funding_apr ?? 0) - (a.funding_apr ?? 0));
    const hi = L[0], lo = L[L.length - 1];
    const s14 = hi.funding_apr_14d != null && lo.funding_apr_14d != null ? Math.round((hi.funding_apr_14d - lo.funding_apr_14d) * 10000) / 10000 : null;
    const basis = hi.mark && lo.mark ? Math.round((hi.mark / lo.mark - 1) * 100000) / 1000 : null;
    items.push({ base, legs: L, spread_apr_now: Math.round(((hi.funding_apr ?? 0) - (lo.funding_apr ?? 0)) * 10000) / 10000, spread_apr_14d: s14, basis_pct: basis, min_leg_vol24_usd: Math.min(...L.map(l => l.vol24_usd ?? 0)) });
  }
  items.sort((a, b) => (b.spread_apr_14d ?? b.spread_apr_now) - (a.spread_apr_14d ?? a.spread_apr_now));
  return { as_of: m.as_of, delay_h: opts.delayH ?? 0, count: items.length, items: items.slice(0, opts.limit ?? 50) };
}

/** Hourly funding history for one coin (dex-prefixed for HIP-3, e.g. "xyz:NBIS"). */
export function coinHistory(coin: string, hours = 24 * 30) {
  ensureCarryTables();
  const since = Date.now() - Math.min(hours, 24 * 3650) * HOUR;
  const rows = getDb().prepare("SELECT ts, funding, premium, mark, oi, vol24, src FROM hl_funding WHERE coin = ? AND ts >= ? ORDER BY ts").all(coin, since) as any[];
  return { coin, ...splitCoin(coin), hours: rows.length, items: rows.map(r => ({ at: new Date(r.ts).toISOString(), funding_1h: r.funding, funding_apr: r.funding == null ? null : Math.round(APR(r.funding) * 10000) / 10000, premium: r.premium, mark: r.mark, oi_usd: r.oi == null ? null : Math.round(r.oi), vol24_usd: r.vol24 == null ? null : Math.round(r.vol24), src: r.src })) };
}

/** Spot × perp on the main dex: perp funding (now, 14 d, % positive hours) next to the spot market of the same asset and the
 *  perp/spot basis. The classic cash-and-carry leg pair. Statistics, not a trade call. */
export function spotPerp(opts: { minVol?: number; limit?: number } = {}) {
  const m = fundingMatrix({ dex: "main" });
  if (!m.as_of) return { as_of: null, items: [] };
  const t = new Date(m.as_of).getTime(); const d = getDb();
  const avg = d.prepare("SELECT AVG(funding) AS a, SUM(CASE WHEN funding > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) AS pos, COUNT(*) AS n FROM hl_funding WHERE coin = ? AND ts > ? AND ts <= ?");
  const items = m.items.filter((i: any) => i.spot && (i.vol24_usd ?? 0) >= (opts.minVol ?? 100_000) && (i.spot.vol24_usd ?? 0) >= (opts.minVol ?? 100_000) / 10).map((i: any) => {
    const a = avg.get(i.coin, t - 14 * 24 * HOUR, t) as any;
    return { base: i.base, perp: i.coin, funding_apr: i.funding_apr, funding_apr_14d: a?.a == null ? null : Math.round(APR(a.a) * 10000) / 10000, hours_positive_14d: a?.pos == null ? null : Math.round(a.pos * 100) / 100, hours_14d: a?.n ?? 0,
      perp_mark: i.mark, spot_mark: i.spot.mark, basis_pct: i.mark && i.spot.mark ? Math.round((i.mark / i.spot.mark - 1) * 100000) / 1000 : null, perp_vol24_usd: i.vol24_usd, spot_vol24_usd: i.spot.vol24_usd, oi_usd: i.oi_usd };
  }).sort((a: any, b: any) => (b.funding_apr_14d ?? b.funding_apr ?? 0) - (a.funding_apr_14d ?? a.funding_apr ?? 0));
  return { as_of: m.as_of, count: items.length, items: items.slice(0, opts.limit ?? 50) };
}
